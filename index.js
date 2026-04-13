#!/usr/bin/env node

/**
 * Jarvis Cloud Companion — 24/7 Telegram Bot
 * 
 * Runs on a cloud server (Render, Railway, etc.) and sends you
 * check-ins, routine reminders, and task nudges throughout the day
 * even when your MacBook is off.
 * 
 * Environment Variables:
 *   BOT_TOKEN     — Telegram bot token from @BotFather
 *   CHAT_ID       — Your Telegram chat ID
 *   FRIENDLY_NAME — Your name (default: 'Abuzar')
 * 
 * Deploy to Render.com:
 *   1. Push this folder to a GitHub repo
 *   2. Go to render.com → New → Background Worker
 *   3. Connect repo, set env vars, deploy
 *   4. Done! Bot runs 24/7 for free
 */

const TelegramBot = require('node-telegram-bot-api');
const companion = require('./companion');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID ? parseInt(process.env.CHAT_ID) : null;
const FRIENDLY_NAME = process.env.FRIENDLY_NAME || 'Abuzar';

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN environment variable is required!');
    console.error('   Get one from @BotFather on Telegram');
    process.exit(1);
}

if (!CHAT_ID) {
    console.error('❌ CHAT_ID environment variable is required!');
    console.error('   Send /start to your bot, check logs for your Chat ID');
    // Don't exit — we'll show the chat ID when someone messages
}

// Update routine.json with friendly name from env
const ROUTINE_FILE = path.join(__dirname, 'routine.json');
try {
    const routine = JSON.parse(fs.readFileSync(ROUTINE_FILE, 'utf8'));
    if (FRIENDLY_NAME && routine.companion) {
        routine.companion.friendlyName = FRIENDLY_NAME;
        fs.writeFileSync(ROUTINE_FILE, JSON.stringify(routine, null, 2));
    }
} catch (e) {
    // Routine file will be created with defaults
}

// ─── START BOT ─────────────────────────────────────────────────────────────

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  🤖 Jarvis Cloud Companion');
console.log('  24/7 Telegram Bot');
console.log(`  Name: ${FRIENDLY_NAME}`);
console.log(`  Chat ID: ${CHAT_ID || '(waiting for first message)'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
    console.error('[Bot] Polling error:', error.message);
});

// Initialize companion if we have a chat ID
if (CHAT_ID) {
    companion.init(bot, CHAT_ID);
}

// ─── SLASH COMMANDS ────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;

    if (!CHAT_ID) {
        bot.sendMessage(chatId,
            `Hello! I am Jarvis 🤖\n\n` +
            `Your Chat ID is: ${chatId}\n\n` +
            `Set this as the CHAT_ID environment variable and restart me!`
        );
        console.log(`[Bot] 📌 Chat ID detected: ${chatId} — set CHAT_ID=${chatId} in your env vars`);
        return;
    }

    if (chatId !== CHAT_ID) {
        bot.sendMessage(chatId, `Unauthorized. Your Chat ID: ${chatId}`);
        return;
    }

    const greeting = companion.getTimeGreeting(new Date().getHours());
    bot.sendMessage(chatId,
        `${greeting}! 🤖 Jarvis Cloud Companion is online 24/7!\n\n` +
        `I'll check in with you, remind you about tasks, and keep you on track.\n\n` +
        `Commands:\n` +
        `📅 /routine — Today's schedule\n` +
        `📌 /tasks — Your task list\n` +
        `📊 /summary — Day summary\n` +
        `➕ /addtask — Add a task\n` +
        `✅ /done — Complete a task\n` +
        `⏰ /remind — Set a reminder\n` +
        `📝 /log — Log an activity\n` +
        `🎯 /checkin — Manual check-in\n` +
        `😊 /mood — How are you feeling?\n\n` +
        `Or just chat naturally! Tell me what you're doing, ask what to do next, or add tasks.`
    );
});

bot.onText(/\/routine/, (msg) => {
    if (msg.chat.id !== CHAT_ID) return;
    bot.sendMessage(msg.chat.id, companion.getRoutineFormatted());
});

bot.onText(/\/tasks/, (msg) => {
    if (msg.chat.id !== CHAT_ID) return;
    bot.sendMessage(msg.chat.id, companion.getTasksFormatted());
});

bot.onText(/\/summary/, async (msg) => {
    if (msg.chat.id !== CHAT_ID) return;
    bot.sendMessage(msg.chat.id, await companion.generateDaySummary());
});

bot.onText(/\/addtask\s+(.+)/, (msg, match) => {
    if (msg.chat.id !== CHAT_ID) return;
    bot.sendMessage(msg.chat.id, companion.addTask(match[1]));
});

bot.onText(/\/addtask$/, (msg) => {
    if (msg.chat.id !== CHAT_ID) return;
    bot.sendMessage(msg.chat.id, 'Usage: /addtask <task description>\nExample: /addtask Finish assignment');
});

bot.onText(/\/done\s+(\d+)/, (msg, match) => {
    if (msg.chat.id !== CHAT_ID) return;
    bot.sendMessage(msg.chat.id, companion.completeTask(parseInt(match[1]) - 1));
});

bot.onText(/\/done$/, (msg) => {
    if (msg.chat.id !== CHAT_ID) return;
    bot.sendMessage(msg.chat.id, `${companion.getTasksFormatted()}\n\nReply: /done <number>`);
});

bot.onText(/\/remind\s+(\d{1,2}:\d{2})\s+(.+)/, (msg, match) => {
    if (msg.chat.id !== CHAT_ID) return;
    bot.sendMessage(msg.chat.id, companion.addReminder(match[2], match[1]));
});

bot.onText(/\/remind$/, (msg) => {
    if (msg.chat.id !== CHAT_ID) return;
    bot.sendMessage(msg.chat.id, 'Usage: /remind HH:MM your reminder\nExample: /remind 15:30 Call mom');
});

bot.onText(/\/log\s+(.+)/, async (msg, match) => {
    if (msg.chat.id !== CHAT_ID) return;
    bot.sendMessage(msg.chat.id, await companion.handleReply(match[1]));
});

bot.onText(/\/checkin/, async (msg) => {
    if (msg.chat.id !== CHAT_ID) return;
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    await companion.sendCheckIn(timeStr);
});

bot.onText(/\/mood/, async (msg) => {
    if (msg.chat.id !== CHAT_ID) return;
    await companion.sendMoodCheck();
});

// ─── MESSAGE HANDLER ───────────────────────────────────────────────────────

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (!text || text.startsWith('/')) return;
    if (chatId !== CHAT_ID) return;

    console.log(`[Bot] Received: ${text} (state: ${companion.convState}, linger: ${companion.isLingering})`);

    // 1. Active companion conversation
    if (companion.convState !== 'idle') {
        bot.sendMessage(chatId, await companion.handleReply(text));
        return;
    }

    // 2. Freeform companion match (tasks, routine questions)
    const freeform = companion.handleFreeformChat(text);
    if (freeform !== null) {
        bot.sendMessage(chatId, freeform);
        return;
    }

    // 3. Lingering — treat as activity update
    if (companion.isLingering) {
        bot.sendMessage(chatId, await companion.handleReply(text));
        return;
    }

    // 4. No match — treat as activity log anyway (cloud has no brain/LLM)
    bot.sendMessage(chatId, await companion.handleReply(text));
});

// ─── KEEP ALIVE ────────────────────────────────────────────────────────────

process.on('SIGINT', () => {
    console.log('\n[Bot] Shutting down...');
    companion.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('[Bot] SIGTERM received, shutting down...');
    companion.stop();
    process.exit(0);
});

console.log('[Bot] Jarvis Cloud Companion is running! 🚀');
