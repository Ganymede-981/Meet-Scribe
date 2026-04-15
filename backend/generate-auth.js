/**
 * generate-auth.js
 *
 * Uses your ALREADY logged-in Chrome profile so Google never asks you to
 * log in again. This bypasses the "can't sign in from this browser" error.
 *
 * Steps:
 *  1. CLOSE ALL CHROME WINDOWS completely before running this
 *  2. Run:  node generate-auth.js
 *  3. A Chrome window opens — you should already be logged into Google
 *  4. Navigate to https://meet.google.com (it may already be open)
 *  5. Close the browser window manually when done
 *  6. auth.json is saved and bot-profile is ready
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';

const CHROME_USER_DATA = path.join(
  os.homedir(),
  'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);

const BOT_PROFILE_DIR = path.join(process.cwd(), 'bot-profile');
const AUTH_FILE = path.join(process.cwd(), 'auth.json');

// Common Chrome executable paths on Windows
const chromePaths = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];
const chromeExe = chromePaths.find(p => fs.existsSync(p));

(async () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   ScribeAI — Google Meet Auth Setup');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Decide which profile to open
  let profileDir;
  if (fs.existsSync(CHROME_USER_DATA)) {
    // Use a COPY of the real Chrome profile so Chrome can be open simultaneously
    profileDir = BOT_PROFILE_DIR;
    if (!fs.existsSync(BOT_PROFILE_DIR) || !fs.existsSync(path.join(BOT_PROFILE_DIR, 'Default'))) {
      console.log('📂 First run: copying your Chrome profile into bot-profile...');
      console.log('   This lets us launch as you without requiring a login.\n');
      fs.mkdirSync(BOT_PROFILE_DIR, { recursive: true });
      // Only copy the Default profile folder (cookies, session, etc.)
      const src = path.join(CHROME_USER_DATA, 'Default');
      const dst = path.join(BOT_PROFILE_DIR, 'Default');
      if (fs.existsSync(src)) {
        fs.cpSync(src, dst, { recursive: true });
        console.log('✅ Profile copied.\n');
      }
    } else {
      console.log('✅ Using existing bot-profile (already has session).\n');
    }
  } else {
    profileDir = BOT_PROFILE_DIR;
    fs.mkdirSync(BOT_PROFILE_DIR, { recursive: true });
    console.log('⚠️  Chrome profile not found — will need manual login.\n');
  }

  console.log('🚀 Launching Chrome with your profile...');
  console.log('   Make sure ALL other Chrome windows are CLOSED first!\n');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: chromeExe,   // use real Chrome if available
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = context.pages()[0] ?? await context.newPage();

  // Navigate to meet.google.com to capture all necessary cookies
  try {
    await page.goto('https://meet.google.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch { /* timeout is OK — we just need cookies */ }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅ Chrome is open and (hopefully) already logged in.');
  console.log('  📌 If NOT logged in, log in now then navigate to:');
  console.log('     https://meet.google.com');
  console.log('  ✅ When ready — CLOSE THIS CHROME WINDOW to save session.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Wait for the user to close the browser
  await new Promise(resolve => context.on('close', resolve));

  // Save cookies to auth.json as backup
  try {
    await context.storageState({ path: AUTH_FILE });
    const saved = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    const count = saved.cookies?.length ?? 0;
    const hasMeet = saved.cookies?.some(c => c.domain.includes('google.com') && !c.domain.includes('accounts'));
    console.log(`\n✅ auth.json saved (${count} cookies).`);
    if (hasMeet) {
      console.log('✅ Google Meet cookies captured. Bot is ready!');
    } else {
      console.log('⚠️  No Meet cookies found. Make sure you visited meet.google.com before closing.');
    }
  } catch {
    console.log('\n✅ bot-profile saved. Auth.json write skipped (context already closed).');
  }

  console.log('\n🎉 Setup complete. You can now start the bot from the frontend.\n');
  process.exit(0);
})().catch(err => {
  console.error('\n❌ Error:', err.message);
  console.error('   Make sure ALL Chrome windows are closed before running this script.');
  process.exit(1);
});