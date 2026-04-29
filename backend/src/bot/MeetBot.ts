import { BrowserContext, chromium, Page } from "playwright";
import { broadcastToSession, sessions } from "../index.js";
import path from "path";
import fs from "fs";
import os from "os";

const EXIT_PHRASES = [
  "notetaker, please leave",
  "note taker, please leave",
  "notetaker please leave",
  "bot please leave",
  "stop recording",
].map((p) => p.toLowerCase());

const LEAVE_BANNER_SEL =
  '[data-call-ended="true"], ' +
  'div[role="heading"]:has-text("You left the meeting"), ' +
  'div[role="heading"]:has-text("You\u2019ve left the call")';

/**
 * Finds the Chrome/Chromium executable path in a cross-platform way.
 *
 * Priority:
 *  1. CHROME_EXECUTABLE_PATH env var  (Docker / EC2 / any custom install)
 *  2. Common Linux paths              (Debian/Ubuntu, Amazon Linux)
 *  3. Common macOS paths
 *  4. Common Windows paths
 *  5. undefined → Playwright uses its own bundled Chromium
 */
function findChrome(): string | undefined {
  // 1. Explicit env var override — highest priority
  if (process.env.CHROME_EXECUTABLE_PATH) {
    return process.env.CHROME_EXECUTABLE_PATH;
  }

  const candidates: string[] = [
    // Linux (Debian/Ubuntu)
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
  ];

  return candidates.find((p) => fs.existsSync(p));
}

export class MeetBot {
  private browser: import('playwright').Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  public exitRequested = false;

  async joinMeeting(sessionId: string, meetUrl: string): Promise<boolean> {
    const send = (payload: object) => broadcastToSession(sessionId, payload);

    try {
      send({ type: "status", status: "initializing", progress: 10 });

      const chromeExe = findChrome();
      console.log(`[Bot] Chrome exe: ${chromeExe ?? "bundled chromium"}`);

      const isProduction = process.env.NODE_ENV === 'production';
      const headless = isProduction;

      // ── Load Google auth cookies ──────────────────────────────
      // Priority: GOOGLE_AUTH_JSON env var (Render) → auth.json file (local dev)
      let storageState: object | undefined;

      if (process.env.GOOGLE_AUTH_JSON) {
        try {
          storageState = JSON.parse(process.env.GOOGLE_AUTH_JSON);
          console.log('[Bot] ✅ Loaded Google auth from GOOGLE_AUTH_JSON env var');
        } catch {
          console.error('[Bot] ❌ Failed to parse GOOGLE_AUTH_JSON — check that it is valid JSON');
        }
      } else {
        const authFile = path.join(process.cwd(), 'auth.json');
        if (fs.existsSync(authFile)) {
          try {
            storageState = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
            const count = (storageState as any).cookies?.length ?? 0;
            console.log(`[Bot] ✅ Loaded Google auth from auth.json (${count} cookies)`);
          } catch {
            console.error('[Bot] ❌ Failed to parse auth.json');
          }
        } else {
          console.warn('[Bot] ⚠️  No auth found (no GOOGLE_AUTH_JSON env var or auth.json). Bot may fail to join.');
        }
      }

      // ── Launch browser ────────────────────────────────────────
      const browser = await chromium.launch({
        headless,
        executablePath: chromeExe,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          "--disable-blink-features=AutomationControlled",
          "--disable-infobars",
          "--window-size=1280,800",
          ...(isProduction ? ["--disable-gpu", "--single-process"] : []),
        ],
        ignoreDefaultArgs: ["--enable-automation"],
      });
      this.browser = browser;

      // ── Create context with injected Google session ───────────
      this.context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        permissions: ['microphone', 'camera'],
        ...(storageState ? { storageState: storageState as any } : {}),
      });

      // Stealth: pass as string so esbuild cannot inject __name helpers
      await this.context.addInitScript(`
        Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; } });
        window.chrome = window.chrome || { runtime: {} };
      `);

      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      this.page.on("console", (msg) =>
        console.log(`[page:${msg.type()}]`, msg.text())
      );

      send({ type: "status", status: "connecting", progress: 25 });
      console.log(`[Bot] Navigating to: ${meetUrl}`);
      await this.page.goto(meetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

      // Dismiss pre-join popups (mic, camera, cookies)
      await this.clickIfVisible(this.page, 'button[aria-label*="Turn off microphone"]');
      await this.clickIfVisible(this.page, 'button[aria-label*="Turn off camera"]');
      await this.clickIfVisible(this.page, 'button:has-text("Got it")');
      await this.clickIfVisible(this.page, 'button:has-text("Accept all")');
      await this.clickIfVisible(this.page, 'button:has-text("Reject all")');

      console.log("[Bot] URL:", this.page.url());
      const btns = await this.page.locator("button").allTextContents();
      console.log("[Bot] Buttons:", btns);

      await this.fillBotName(this.page);
      await this.clickJoin(this.page);
      await this.collapsePreviewIfNeeded(this.page);
      await this.dismissOverlays(this.page);
      await this.waitUntilJoined(this.page);
      console.log("[Bot] ✅ Joined meeting!");
      send({ type: "status", status: "active", progress: 50 });

      await this.ensureCaptionsOn(this.page);
      console.log("[Bot] ✅ Captions enabled!");

      await this.scrapeCaptions(this.page, sessionId, send);
      console.log("[Bot] Done scraping.");

      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Bot ${sessionId}] Error: ${message}`);

      // Save screenshot for debugging
      if (this.page) {
        const tmpDir = path.join(process.cwd(), "tmp");
        fs.mkdirSync(tmpDir, { recursive: true });
        const screenshot = path.join(tmpDir, `bot-error-${Date.now()}.png`);
        await this.page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
        console.log(`[Bot] Debug screenshot saved: ${screenshot}`);
      }

      send({ type: "status", status: "error", message });
      await this.cleanup();
      return false;
    }
  }

  // ─── Caption scraping — debounce-based deduplication ─────────────────────
  //
  // Google Meet streams caption updates as rapid DOM mutations. Each word
  // arrival refines the current sentence in-place. We must NOT save every
  // intermediate update; instead we wait for either:
  //   (a) isFinal=true — fired when the caption DOM node is removed from the
  //       page (Meet's signal that the speaker finished the sentence), OR
  //   (b) FLUSH_DELAY_MS of silence from that speaker (debounce fallback).
  // Only one final line per sentence reaches the transcript.

  private async scrapeCaptions(
    page: Page,
    sessionId: string,
    send: (payload: object) => void
  ) {
    this.exitRequested = false;

    /** How long (ms) to wait after the last word before committing a sentence. */
    const FLUSH_DELAY_MS = 1500;

    /** Most-recent rolling text per speaker (not yet committed). */
    const pending = new Map<string, string>();

    /** Active debounce timers per speaker. */
    const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /** Already-committed lines — prevents exact duplicates on reconnect. */
    const committed = new Set<string>();

    const isNoise = (text: string) =>
      // Google Meet system notifications and UI element labels that leak through
      /you left the meeting|return to home screen|leave call|feedback|audio and video|learn more|your microphone|your camera|this video is paused|font size|more options|network problem|connection problem|you're muted|you are muted|someone's screen|presenting|join audio|continue without|background|blur|noise cancellation|captions settings|turn (on|off) captions|reactions|raise hand|present now|everyone|pin|spotlight|remove|report|mute|ask to unmute|make (co-)?host/i.test(text);

    /** Require at least 3 whitespace-separated words — rules out single UI labels */
    const hasEnoughWords = (text: string) => text.trim().split(/\s+/).length >= 3;

    /**
     * Checkpoint = the full text we already extracted from each speaker's caption
     * bubble. Google Meet never resets the bubble — it just keeps appending words.
     * So instead of committing the full accumulated string on every flush, we only
     * commit the DELTA (new words since the last checkpoint).
     *
     * When isFinal=true (the DOM node was removed), we clear the checkpoint so the
     * next caption node for that speaker starts fresh.
     */
    const checkpoint = new Map<string, string>();

    const flush = (speaker: string, isFinal: boolean = false): void => {
      const fullText = pending.get(speaker);
      if (!fullText) return;
      pending.delete(speaker);

      const t = flushTimers.get(speaker);
      if (t) { clearTimeout(t); flushTimers.delete(speaker); }

      // Extract only the new words since the last checkpoint
      const last = checkpoint.get(speaker) ?? '';
      let delta: string;
      if (fullText.startsWith(last)) {
        // Normal growth: caption bubble expanded — take only the new suffix
        delta = fullText.substring(last.length).replace(/^[\s.,!?;:\-–—]+/, '').trim();
      } else {
        // Caption was reset or speaker context changed — take full text
        delta = fullText.trim();
      }

      if (!delta || delta.length < 3) {
        // Nothing meaningful to commit; still advance checkpoint if the
        // full text grew (avoids re-reading the same content later)
        if (fullText.length > last.length) checkpoint.set(speaker, fullText);
        return;
      }

      if (isFinal) {
        // Node removed — next caption for this speaker will be a fresh bubble
        checkpoint.delete(speaker);
      } else {
        // Silence-based flush — advance watermark so next flush takes only delta
        checkpoint.set(speaker, fullText);
      }

      const formatted = `[${speaker}]: ${delta}`;
      if (committed.has(formatted)) return;
      committed.add(formatted);

      const session = sessions.get(sessionId);
      if (session) {
        session.transcript.push(formatted);
        send({ type: 'transcript', text: formatted });
      }
      console.log(`[Bot] ✅ Caption: ${formatted.slice(0, 120)}`);
    };

    // ── Node-side caption handler ────────────────────────────────────────────
    // Called from browser via window.onCaption(speaker, text, isFinal).
    await page.exposeFunction(
      'onCaption',
      async (speaker: string, text: string, isFinal: boolean) => {
        const caption = text.trim();
        // Reject noise strings and short UI labels
        if (!caption || isNoise(caption) || !hasEnoughWords(caption)) return;

        // Exit-phrase detection
        if (EXIT_PHRASES.some((p) => caption.toLowerCase().includes(p))) {
          console.log('[Bot] Exit phrase detected — leaving.');
          this.exitRequested = true;
        }

        // Always keep the latest (longest) version of the rolling text
        pending.set(speaker, caption);

        // Reset the debounce timer for this speaker
        const existing = flushTimers.get(speaker);
        if (existing) clearTimeout(existing);

        if (isFinal) {
          // Caption node was removed from DOM → sentence is complete, reset checkpoint
          flush(speaker, true);
        } else {
          // Still being typed — commit the delta after FLUSH_DELAY_MS of silence
          flushTimers.set(
            speaker,
            setTimeout(() => flush(speaker, false), FLUSH_DELAY_MS)
          );
        }
      }
    );


    // Wait for aria-live region to appear (captions container)
    await page.waitForSelector('[aria-live]', { timeout: 60_000 });
    await page.waitForFunction(
      "Array.from(document.querySelectorAll('[aria-live]')).some(function(el) { return el.textContent && el.textContent.trim().length > 0; })",
      { timeout: 60_000 }
    ).catch(() => { console.log('[Bot] aria-live timeout — proceeding anyway'); });

    // ── Browser-side MutationObserver ────────────────────────────────────────
    // CRITICAL: Passed as a STRING so esbuild/tsx never transforms it.
    //
    // Key design: isCaptionNode() walks up the DOM to check whether a mutated
    // node lives inside the captions container (aria-live region). This prevents
    // Google Meet's menus, tooltips, notifications, and other UI elements from
    // being mistaken for speech captions.
    await page.evaluate(`
      (function() {
        var badgeSel = '.NWpY1d, .xoMHSc, .YmBy7, .j9vN6e';
        var lastSpeaker = 'Unknown Speaker';
        var nodeCache = new Map();

        // ── Guard: only process mutations inside the captions region ──────────
        function isCaptionNode(node) {
          var el = node;
          while (el && el !== document.body) {
            if (el.getAttribute) {
              var live = el.getAttribute('aria-live');
              var role = el.getAttribute('role');
              var label = (el.getAttribute('aria-label') || '').toLowerCase();
              if (live || (role === 'region' && label.indexOf('caption') !== -1)) {
                return true;
              }
            }
            el = el.parentElement;
          }
          return false;
        }

        function getSpeaker(node) {
          var badge = node.querySelector ? node.querySelector(badgeSel) : null;
          var name = badge && badge.textContent && badge.textContent.trim();
          if (name) lastSpeaker = name;
          return lastSpeaker || 'Unknown Speaker';
        }

        function getText(node) {
          var clone = node.cloneNode(true);
          var badges = clone.querySelectorAll(badgeSel);
          for (var i = 0; i < badges.length; i++) badges[i].remove();
          return (clone.textContent && clone.textContent.trim()) || '';
        }

        function emit(node, isFinal) {
          var txt = getText(node);
          var spk = getSpeaker(node);
          if (txt && txt.length > 2 && txt.toLowerCase() !== spk.toLowerCase()) {
            nodeCache.set(node, { spk: spk, txt: txt });
            if (window.onCaption) window.onCaption(spk, txt, isFinal);
          }
        }

        new MutationObserver(function(mutations) {
          var i, j, m, n, cached;
          for (i = 0; i < mutations.length; i++) {
            m = mutations[i];

            // ── New caption nodes (sentence in progress) ──────────────────
            for (j = 0; j < m.addedNodes.length; j++) {
              n = m.addedNodes[j];
              if (n instanceof HTMLElement && isCaptionNode(n)) emit(n, false);
            }

            // ── Text updated within existing caption node ──────────────────
            if (m.type === 'characterData' && m.target && m.target.parentElement instanceof HTMLElement) {
              if (isCaptionNode(m.target.parentElement)) emit(m.target.parentElement, false);
            }

            // ── Caption node removed → sentence is final ───────────────────
            // (node removal happens outside the captions region after Meet
            //  dismisses the bubble, so we skip the isCaptionNode check here)
            for (j = 0; j < m.removedNodes.length; j++) {
              n = m.removedNodes[j];
              if (n instanceof HTMLElement) {
                cached = nodeCache.get(n);
                if (cached && cached.txt) {
                  nodeCache.delete(n);
                  if (window.onCaption) window.onCaption(cached.spk, cached.txt, true);
                }
              }
            }
          }
        }).observe(document.body, { childList: true, characterData: true, subtree: true });
      })();
    `);

    const leaveCall = async () => {
      const hangUpSel =
        'button[aria-label*="Leave call"], button[aria-label*="Leave meeting"]';
      if (await page.$(hangUpSel)) {
        await this.clickIfVisible(page, hangUpSel);
      } else {
        await page.keyboard.press('Ctrl+Alt+Q');
      }
      await page
        .waitForSelector(LEAVE_BANNER_SEL, { timeout: 10_000 })
        .catch(() => undefined);
    };

    await Promise.race([
      (async () => {
        while (!this.exitRequested) {
          await new Promise((r) => setTimeout(r, 500));
        }
        await leaveCall();
      })(),
      page
        .waitForSelector(LEAVE_BANNER_SEL, { timeout: 0 })
        .catch(() => undefined),
      new Promise<void>((_, rej) =>
        setTimeout(
          () => rej(new Error('Hard timeout (120 min) exceeded')),
          120 * 60 * 1000
        )
      ),
    ]);

    // Flush any remaining pending segments before processing
    for (const speaker of pending.keys()) {
      flush(speaker, true);
    }

    send({ type: 'status', status: 'processing', progress: 85 });
    await this.cleanup();
  }

  // ─── Helper methods ───────────────────────────────────────────────────────

  /** Auto-fills the bot display name if the pre-join name input is visible. */
  private async fillBotName(page: Page): Promise<void> {
    const nameInput = page.locator(
      'input[aria-label*="name" i], input[placeholder*="name" i]'
    ).first();
    try {
      await nameInput.waitFor({ state: "visible", timeout: 5000 });
      await nameInput.click({ clickCount: 3 });
      await nameInput.fill("Bot");
      console.log('[Bot] Filled display name: "Bot"');
    } catch {
      // Name field not present — already authenticated or not required
      console.log('[Bot] No name input found — skipping name fill');
    }
  }

  private async clickIfVisible(
    page: Page,
    selector: string,
    timeout = 5000
  ): Promise<boolean> {
    try {
      const elem = page.locator(selector).first();
      await elem.waitFor({ state: "visible", timeout });
      await elem.click();
      return true;
    } catch {
      return false;
    }
  }

  private async clickJoin(page: Page): Promise<void> {
    // Handle "Continue without mic/camera" first
    const continueBtn = page.locator(
      'button:has-text("Continue without microphone and camera")'
    );
    try {
      await continueBtn.waitFor({ state: "visible", timeout: 3000 });
      await continueBtn.click();
      await page.waitForTimeout(1000);
      console.log('[Bot] Clicked "Continue without microphone and camera"');
    } catch {}

    const possibilities = [
      "Join now",
      "Ask to join",
      "Join meeting",
      "Join call",
      "Join",
      "Done",
      "Continue to join",
      "Start meeting",
    ];

    for (const text of possibilities) {
      const btn = page.locator(`button:has-text("${text}")`).first();
      try {
        await btn.waitFor({ state: "visible", timeout: 3000 });
        await btn.click();
        console.log(`[Bot] Clicked join button: "${text}"`);
        return;
      } catch {}
    }

    // Fallback: any button containing "join"
    const allBtns = page.locator("button");
    const count = await allBtns.count();
    for (let i = 0; i < count; i++) {
      const btn = allBtns.nth(i);
      const label = (await btn.textContent())?.trim() ?? "";
      if (/join/i.test(label)) {
        try {
          await btn.click();
          console.log(`[Bot] Fallback clicked: "${label}"`);
          return;
        } catch {}
      }
    }

    console.warn("[Bot] No join button found — pressing Enter");
    await page.keyboard.press("Enter");
  }

  private async waitUntilJoined(page: Page, timeoutMs = 90_000) {
    const result = await Promise.race([
      page.waitForSelector('button[aria-label*="Leave call"]', { timeout: timeoutMs }),
      page.waitForSelector('button[aria-label*="Leave meeting"]', { timeout: timeoutMs }),
      page.waitForSelector("text=You've been admitted", { timeout: timeoutMs }),
      page.waitForSelector("text=You're the only one here", { timeout: timeoutMs }),
    ]).catch(() => null);

    if (!result) {
      // Check if blocked by Google
      const blocked = await page
        .locator("text=You can't join this meeting")
        .isVisible()
        .catch(() => false);
      if (blocked) {
        throw new Error(
          "Google blocked the bot: 'You can\u2019t join this meeting'. The meeting may be restricted to org members."
        );
      }
      throw new Error("Timed out waiting to join the meeting (90s).");
    }
  }

  private async collapsePreviewIfNeeded(page: Page) {
    const previewJoin = page.getByRole("button", { name: /join now/i }).nth(1);
    if (await previewJoin.isVisible({ timeout: 3000 }).catch(() => false)) {
      await previewJoin.click();
      console.log("[Bot] Collapsed 2-step join preview");
    }
  }

  private async dismissOverlays(page: Page) {
    const sels = [
      'button:has-text("Got it")',
      'button:has-text("Dismiss")',
      'button:has-text("Continue")',
    ];
    for (const sel of sels) {
      await this.clickIfVisible(page, sel, 1_000);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
  }

  private async captionsRegionVisible(page: Page, t = 4000): Promise<boolean> {
    try {
      const region = page.locator('[role="region"][aria-label*="Captions"]');
      await region.waitFor({ timeout: t });
      return true;
    } catch {
      return false;
    }
  }

  private async ensureCaptionsOn(page: Page) {
    await page.waitForTimeout(5000);

    // Close any blocking overlays
    const overlay = page.locator('div[data-disable-esc-to-close="true"]');
    for (let i = 0; i < 8; i++) {
      if (!(await overlay.isVisible().catch(() => false))) break;
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }

    // Try Shift+C up to 10 times
    for (let i = 0; i < 10; i++) {
      console.log(`[Bot] Attempt ${i + 1}: Pressing Shift+C`);
      await page.keyboard.down("Shift");
      await page.keyboard.press("c");
      await page.keyboard.up("Shift");

      if (await this.captionsRegionVisible(page, 800)) {
        console.log("[Bot] Captions enabled via Shift+C");
        return;
      }

      const alreadyOn = page.locator('button[aria-label*="Turn off captions"]');
      if (await alreadyOn.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log("[Bot] Captions already ON");
        return;
      }

      await page.waitForTimeout(600);
    }

    // Fallback: click the "Turn on captions" button directly
    await page.mouse.move(500, 700);
    await page.waitForTimeout(300);
    const ccBtn = page.locator('button[aria-label*="Turn on captions"]');
    try {
      await ccBtn.waitFor({ state: "visible", timeout: 4000 });
      await ccBtn.click();
      if (await this.captionsRegionVisible(page, 5000)) {
        console.log("[Bot] Captions enabled via button click");
        return;
      }
    } catch {}

    // Save debug screenshot and throw
    if (this.page) {
      const tmpDir = path.join(process.cwd(), "tmp");
      fs.mkdirSync(tmpDir, { recursive: true });
      const ss = path.join(tmpDir, `captions-fail-${Date.now()}.png`);
      await this.page.screenshot({ path: ss }).catch(() => undefined);
      console.error(`[Bot] Caption enable failed. Screenshot: ${ss}`);
    }
    throw new Error("Could not enable captions using Shift+C or button click.");
  }

  async stop(): Promise<void> {
    this.exitRequested = true;
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close();
        this.context = null;
        this.page = null;
      }
    } catch {}
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    } catch {}
  }
}