// backend/src/services/BotService.ts
import { chromium, Browser, BrowserContext, Page } from "playwright";
import path from "path";
import fs from "fs";

export interface BotCallbacks {
    onStatusChange: (status: string, progress: number) => void;
    onTranscriptLine: (line: string) => void;
    onComplete: (fullTranscript: string[]) => void;
    onError: (error: string) => void;
}

export class BotService {
    private EXIT_PHRASES = ["notetaker, please leave", "bot, leave", "stop recording"];
    private activeSegments = new Map<string, { speaker: string; text: string }>();
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private exitRequested = false;

    async deployBot(url: string, callbacks: BotCallbacks): Promise<void> {
        const { onStatusChange, onTranscriptLine, onComplete, onError } = callbacks;

        try {
            onStatusChange("initializing", 10);

            // 1. Launch Browser with Stealth flags
            const isProduction = process.env.NODE_ENV === 'production';
            this.browser = await chromium.launch({
                headless: isProduction, // headless=true on server (no display), visible locally for debugging
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-gpu",              // required for headless Linux (Render/Docker)
                    "--use-fake-ui-for-media-stream",
                    "--use-fake-device-for-media-stream",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-infobars",
                    "--window-size=1280,800"
                ],
            });

            this.context = await this.browser.newContext({
                viewport: { width: 1280, height: 800 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                permissions: ['microphone', 'camera']
            });

            // 🌟 CRITICAL STEALTH: Remove webdriver flag so Google doesn't redirect to apps.google.com/meet/
            await this.context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined,
                });
            });

            this.page = await this.context.newPage();
            const transcriptLog: string[] = [];
            this.exitRequested = false;

            // 1. Join Meeting Logic
            onStatusChange("connecting", 25);
            console.log(`[BotService] 🌐 Navigating to: ${url}`);
            
            await this.page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

            // ── Step 1.1: Pre-join hard dismissals ──────────────────
            await this.handlePreJoinPopups();

            // ── Step 1.2: Identity ──────────────────────────────────
            const nameInput = this.page.locator('input[aria-label*="name" i], input[placeholder*="name" i]');
            if (await nameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
                console.log("[BotService] 👤 Setting display name...");
                await nameInput.fill("ScribeAI Bot");
                await this.page.keyboard.press("Enter");
            }

            // ── Step 1.3: Direct Join ───────────────────────────────
            console.log("[BotService] 🖱️ Looking for Join buttons...");
            const clicked = await this.clickJoin(this.page);
            if (!clicked) {
                console.warn("[BotService] ⚠️ No obvious join/rejoin button. Bot might be stuck.");
            }

            // ── Step 1.4: Wait for Lobby Admission ───────────────────
            await this.waitUntilJoined(this.page);
            onStatusChange("active", 50);

            // 2. Enable Captions
            await this.ensureCaptionsOn(this.page);

            // 3. Inject Caption Scraper
            await this.page.exposeFunction("onCaption", (speaker: string, text: string) => {
                const caption = text.trim();
                if (!caption) return;

                if (this.EXIT_PHRASES.some((p) => caption.toLowerCase().includes(p))) {
                    console.log(`[BotService] 🚪 Exit phrase detected: "${caption}"`);
                    this.exitRequested = true;
                }

                const existing = this.activeSegments.get(speaker);
                if (!existing || caption.length > existing.text.length + 5 || !caption.startsWith(existing.text)) {
                    this.activeSegments.set(speaker, { speaker, text: caption });
                    const formattedLine = `[${speaker}]: ${caption}`;
                    if (!transcriptLog.includes(formattedLine)) {
                        transcriptLog.push(formattedLine);
                        onTranscriptLine(formattedLine);
                    }
                }
            });

            // Injection
            await this.page.evaluate(() => {
                let lastSpeaker = "Participant";
                new MutationObserver((mutations) => {
                    mutations.forEach((m) => {
                        let target = m.target;
                        if (m.type === "characterData") target = target.parentElement as Node;
                        if (target instanceof HTMLElement) {
                            const clone = target.cloneNode(true) as HTMLElement;
                            clone.querySelectorAll(".NWpY1d, .xoMHSc, .YmBy7, .j9vN6e").forEach((el) => {
                                lastSpeaker = el.textContent?.trim() || lastSpeaker;
                                el.remove();
                            });
                            const text = clone.textContent?.trim() || "";
                            if (text && text.length > 2) (window as any).onCaption(lastSpeaker, text);
                        }
                    });
                }).observe(document.body, { childList: true, characterData: true, subtree: true });
            });

            // 4. Stay active
            while (!this.exitRequested && this.browser) {
                const leftBanner = await this.page.locator('div[role="heading"]:has-text("You left the meeting")').isVisible().catch(() => false);
                if (leftBanner) break;
                await this.page.waitForTimeout(2000);
            }

            onStatusChange("processing", 75);
            await this.cleanup();
            onComplete(transcriptLog);

        } catch (err: any) {
            console.error("[BotService] 💣 Bot Crash:", err.message);
            // Save state for debugging
            if (this.page) {
                const errorFile = `bot-error-${Date.now()}.png`;
                const tmpPath = path.join(process.cwd(), "tmp", errorFile);
                if (!fs.existsSync(path.dirname(tmpPath))) fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
                try {
                   await this.page.screenshot({ path: tmpPath, fullPage: true });
                   console.log(`[BotService] 📸 Diagnostic screenshot saved: ${tmpPath}`);
                } catch (e) {}
            }
            await this.cleanup();
            onError(`Bot failed to join meeting screen. Raw Error: ${err.message}`);
        }
    }

    async stop(): Promise<void> {
        this.exitRequested = true;
        await this.cleanup();
    }

    private async cleanup() {
        if (this.browser) {
            try { await this.browser.close(); } catch {}
            this.browser = null; this.context = null; this.page = null;
        }
    }

    private async handlePreJoinPopups() {
        if (!this.page) return;
        const popups = [
            'button:has-text("Got it")',
            'button:has-text("Dismiss")',
            'button[aria-label*="Dismiss" i]',
            'button[aria-label*="Close" i]'
        ];
        for (const sel of popups) {
            try { 
                const el = this.page.locator(sel).first();
                if (await el.isVisible({ timeout: 2000 })) await el.click();
            } catch {}
        }
    }

    private async clickJoin(page: Page): Promise<boolean> {
        const joinTexts = ["Join now", "Ask to join", "Join Meeting", "Rejoin", "Join"];
        for (const t of joinTexts) {
            try {
                const btn = page.locator(`button:has-text("${t}")`).first();
                if (await btn.isVisible({ timeout: 2000 })) {
                    await btn.click();
                    console.log(`[BotService] ✅ Clicked: ${t}`);
                    return true;
                }
            } catch {}
        }
        return false;
    }

    private async waitUntilJoined(page: Page) {
        try {
            await Promise.race([
                page.waitForSelector('button[aria-label*="Leave call" i]', { timeout: 60000 }),
                page.waitForSelector('text=You\'ve been admitted', { timeout: 60000 }),
                page.waitForSelector('[aria-label="Meeting details" i]', { timeout: 60000 })
            ]);
            console.log("[BotService] 🎉 Successfully in meeting!");
        } catch (e) {
            // Check if we are on the "You can't join this meeting" screen
            const errorText = await page.locator('text=You can\'t join this meeting').isVisible().catch(() => false);
            if (errorText) throw new Error("Google blocked the bot: 'You can't join this meeting'. The link might be restricted to organizational users only.");
            throw new Error("Joining timed out. Stuck in lobby or join button did not process.");
        }
    }

    private async ensureCaptionsOn(page: Page) {
        await page.waitForTimeout(4000);
        await page.keyboard.press("Shift+c");
        console.log("[BotService] 💬 Caption toggle (Shift+C) sent");
    }
}