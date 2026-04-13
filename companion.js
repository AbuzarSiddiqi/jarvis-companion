const fs = require('fs');
const path = require('path');

/**
 * Jarvis Cloud Companion
 * Lightweight companion service that runs on a cloud server 24/7.
 * Handles check-ins, tasks, routine, reminders — no macOS needed.
 * Syncs with local Mac app via JSONBin when JSONBIN_KEY is set.
 */

const DATA_DIR = path.join(__dirname, 'data');
const ROUTINE_FILE = path.join(__dirname, 'routine.json');

// Cloud sync (optional — works without it too)
let sync = null;
try {
    sync = require('./sync');
    if (process.env.JSONBIN_KEY) {
        sync.masterKey = process.env.JSONBIN_KEY;
        if (process.env.JSONBIN_BIN_ID) sync.setBinId(process.env.JSONBIN_BIN_ID);
        console.log('[Companion] JSONBin sync enabled ✅');
    } else {
        sync = null;
    }
} catch (e) {
    sync = null;
}

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const LINGER_DURATION_MS = 4 * 60 * 1000;

class CompanionService {
    constructor() {
        this.bot = null;
        this.chatId = null;
        this.checkInTimers = [];
        this.reminderTimers = [];
        this.routine = null;

        this.convState = 'idle';
        this.lastCheckInTime = null;
        this.lastFollowUpContext = null;
        this.lastCompanionInteraction = null;
        this.morningKickoffDone = false;
        this.todayDate = null;
    }

    get isLingering() {
        if (!this.lastCompanionInteraction) return false;
        return Date.now() - this.lastCompanionInteraction < LINGER_DURATION_MS;
    }

    touchInteraction() {
        this.lastCompanionInteraction = Date.now();
    }

    // ─── INIT ──────────────────────────────────────────────────────────────

    async init(bot, chatId) {
        this.bot = bot;
        this.chatId = chatId;
        this.routine = this.loadRoutine();

        console.log('[Companion] Initializing cloud companion...');

        // Pull latest data from JSONBin first (may override local routine.json)
        await this.syncFromCloud();

        this.scheduleCheckIns();
        this.scheduleReminders();
        this.scheduleSummary();
        this.scheduleMorningKickoff();

        // Reschedule everything at midnight
        this.scheduleMidnightReset();

        // Sync from cloud every 5 minutes to pick up Mac app changes
        setInterval(() => this.syncFromCloud(), 5 * 60 * 1000);

        console.log('[Companion] Cloud companion ready!');
    }

    // ─── MIDNIGHT RESET ────────────────────────────────────────────────────

    scheduleMidnightReset() {
        const now = new Date();
        const midnight = new Date(now);
        midnight.setHours(24, 0, 30, 0); // 00:00:30 next day

        const delayMs = midnight.getTime() - now.getTime();
        setTimeout(() => {
            console.log('[Companion] Midnight reset — rescheduling everything');
            this.morningKickoffDone = false;
            this.todayDate = null;
            this.routine = this.loadRoutine();
            this.scheduleCheckIns();
            this.scheduleReminders();
            this.scheduleSummary();
            this.scheduleMorningKickoff();
            this.scheduleMidnightReset(); // Reschedule for next midnight
        }, delayMs);

        console.log(`[Companion] Midnight reset in ${Math.round(delayMs / 1000 / 60)} minutes`);
    }

    // ─── ROUTINE LOADING ───────────────────────────────────────────────────

    loadRoutine() {
        try {
            return JSON.parse(fs.readFileSync(ROUTINE_FILE, 'utf8'));
        } catch (e) {
            console.error('[Companion] Failed to load routine:', e.message);
            return { weeklyRoutine: {}, companion: { enabled: true, friendlyName: 'hey' }, reminders: [], tasks: [] };
        }
    }

    refreshRoutine() {
        this.routine = this.loadRoutine();
    }

    /** Pull latest data from JSONBin into local routine.json */
    async syncFromCloud() {
        if (!sync || !sync.isConfigured()) return;
        try {
            const data = await sync.read();
            if (data && data.routine) {
                // Merge tasks/reminders from cloud into routine
                const merged = { ...data.routine, tasks: data.tasks || data.routine.tasks || [], reminders: data.routine.reminders || [] };
                fs.writeFileSync(ROUTINE_FILE, JSON.stringify(merged, null, 2));
                this.routine = merged;
                console.log('[Sync] Pulled latest from JSONBin');
            }
        } catch (e) {
            console.warn('[Sync] Pull failed (using local):', e.message);
        }
    }

    /** Push current routine+tasks to JSONBin */
    async pushToCloud() {
        if (!sync || !sync.isConfigured()) return;
        try {
            await sync.update({ routine: this.routine, tasks: this.routine.tasks || [], lastUpdated: new Date().toISOString() });
            console.log('[Sync] Pushed to JSONBin');
        } catch (e) {
            console.warn('[Sync] Push failed:', e.message);
        }
    }

    getTodayRoutine() {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const today = days[new Date().getDay()];
        let routine = this.routine.weeklyRoutine[today] || [];
        if (routine.length === 0 && this.routine.copyMondayToAll) {
            routine = this.routine.weeklyRoutine['monday'] || [];
        }
        return routine;
    }

    // ─── ACTIVITY LOGGING ──────────────────────────────────────────────────

    logActivity(text) {
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(DATA_DIR, `log-${today}.json`);
        const time = new Date().toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', hour12: true,
            timeZone: 'Asia/Kolkata'
        });

        let logs = [];
        if (fs.existsSync(logFile)) {
            try { logs = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch (e) { logs = []; }
        }

        const entry = { time, timestamp: Date.now(), activity: text, source: 'telegram' };
        logs.push(entry);
        fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
        console.log(`[Companion] Logged: "${text}" at ${time}`);
        return { time, entry, totalToday: logs.length };
    }

    getTodayLogs() {
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(DATA_DIR, `log-${today}.json`);
        if (!fs.existsSync(logFile)) return [];
        try { return JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch (e) { return []; }
    }

    // ─── ROUTINE COMPARISON ────────────────────────────────────────────────

    getRoutineComparison(activityText) {
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const routine = this.getTodayRoutine();

        let closestItem = null, closestDiff = Infinity;
        for (const item of routine) {
            const [h, m] = item.time.split(':').map(Number);
            const diff = Math.abs(currentMinutes - (h * 60 + m));
            if (diff < closestDiff) { closestDiff = diff; closestItem = item; }
        }
        if (!closestItem) return null;

        const actLower = activityText.toLowerCase();
        const isOnTrack = closestItem.activity.toLowerCase().split(/[\s\/]+/).some(
            word => word.length > 3 && actLower.includes(word)
        );
        return { expected: closestItem, isOnTrack, deviation: closestDiff };
    }

    // ─── HELPERS ───────────────────────────────────────────────────────────

    getPendingTasks() {
        return (this.routine.tasks || []).filter(t => !t.completed);
    }

    getHotseatRoutineItems() {
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const routine = this.getTodayRoutine();
        const logsStr = this.getTodayLogs().map(l => l.activity.toLowerCase()).join(' ');

        return routine.filter(item => {
            const [h, m] = item.time.split(':').map(Number);
            const itemMin = h * 60 + m;
            const inWindow = itemMin >= nowMin - 60 && itemMin <= nowMin + 90;
            const words = item.activity.toLowerCase().split(/[\s\/]+/).filter(w => w.length > 3);
            const alreadyLogged = words.some(w => logsStr.includes(w));
            return inWindow && !alreadyLogged;
        });
    }

    // ─── FREEFORM CHAT HANDLER ─────────────────────────────────────────────

    handleFreeformChat(text) {
        const lower = text.toLowerCase().trim();

        if (/what (?:should|to|can|do) (?:i |we )?do|according to (?:my )?routine|my schedule|what.?s next|what now/i.test(lower)) {
            return this.suggestBasedOnRoutine();
        }

        // Catches: "add a task", "add task", "add to task", "add to my tasks", "remind me", "i need to"
        if (/^(?:add (?:a |to |to my )?task|remind me|i (?:need|have|want|got) to)/i.test(lower)) {
            return this.parseAndAddTask(text);
        }

        if (/^(?:my |pending |show |list |all )?tasks$|what.?s pending|show (?:my )?tasks|list (?:my )?tasks/i.test(lower)) {
            return this.getTasksFormatted();
        }

        if (/(?:my |show |today.?s )?(?:routine|schedule|timetable)/i.test(lower)) {
            return this.getRoutineFormatted();
        }

        if (this.isLingering && lower.length < 15) {
            return this.handleShortReply(lower);
        }

        return null;
    }

    suggestBasedOnRoutine() {
        this.refreshRoutine();
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const routine = this.getTodayRoutine();
        const name = this.routine.companion?.friendlyName || 'hey';
        const pending = this.getPendingTasks();

        let currentItem = null, nextItem = null;
        for (const item of routine) {
            const [h, m] = item.time.split(':').map(Number);
            const itemMin = h * 60 + m;
            if (itemMin <= nowMin) currentItem = item;
            if (itemMin > nowMin && !nextItem) nextItem = item;
        }

        let msg = `Hey ${name}! Here's what's on your plate:\n\n`;
        if (currentItem) msg += `🕐 Right now: ${currentItem.activity}\n`;
        if (nextItem) msg += `⏭️ Coming up: ${nextItem.activity} at ${nextItem.time}\n`;

        if (!currentItem && !nextItem && routine.length > 0) {
            msg += `Looks like you're past today's routine! 🌙\n`;
        } else if (routine.length === 0) {
            msg += `No routine set for today — go with the flow! 😊\n`;
        }

        if (pending.length > 0) {
            msg += `\n📌 Pending tasks (${pending.length}):\n`;
            pending.slice(0, 4).forEach(t => {
                msg += `  • ${t.text}${t.time ? ` ⏰${t.time}` : ''}\n`;
            });
        }

        msg += this.pick([
            `\nFocus on one thing at a time — you've got this! 💪`,
            `\nSmall steps, ${name}! Progress > perfection 🎯`,
            `\nJust keep moving forward! 🚀`,
        ]);

        this.touchInteraction();
        return msg;
    }

    parseAndAddTask(text) {
        let taskText = text.replace(
            /^(?:add (?:a )?task (?:that )?(?:i (?:have |need |want |got )?(?:to )?)?|remind me (?:to )?|i (?:need|have|want|got) to )/i,
            ''
        ).trim();

        let time = null;
        const timeMatch = taskText.match(/(?:at |by |before )(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
        if (timeMatch) {
            time = timeMatch[1].trim();
            taskText = taskText.replace(timeMatch[0], '').trim();
        }

        taskText = taskText.replace(/\s+(?:today|tomorrow|later|soon)$/i, '').trim();

        if (!taskText) return '❌ Couldn\'t figure out the task. Try: "add a task finish homework"';

        this.touchInteraction();
        return this.addTask(taskText, time);
    }

    handleShortReply(lower) {
        if (/^(?:what|huh|hmm|\?+|wha)$/.test(lower)) return this.suggestBasedOnRoutine();
        if (/^(?:ok|okay|alright|sure|yes|yeah|yep|fine|cool|nice)$/i.test(lower)) {
            this.touchInteraction();
            return this.pick([`Keep at it! 🔥`, `You're doing great 💪`, `That's the spirit! 🌟`]);
        }
        if (/^(?:no|nope|nah|not really|nothing|idk)$/i.test(lower)) return this.suggestBasedOnRoutine();
        return null;
    }

    // ─── MORNING KICKOFF ───────────────────────────────────────────────────

    scheduleMorningKickoff() {
        const config = this.routine.companion || {};
        if (!config.enabled) return;

        const kickoffTime = config.firstCheckIn || '08:00';
        const [h, m] = kickoffTime.split(':').map(Number);
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const targetMin = h * 60 + m;

        const today = now.toISOString().split('T')[0];
        if (this.todayDate !== today) {
            this.morningKickoffDone = false;
            this.todayDate = today;
        }
        if (this.morningKickoffDone) return;

        let delayMs = targetMin <= nowMin ? 5000 : (targetMin - nowMin) * 60 * 1000;
        setTimeout(() => this.sendMorningKickoff(), delayMs);
        console.log(`[Companion] Morning kickoff in ${Math.round(delayMs / 1000)}s`);
    }

    async sendMorningKickoff() {
        if (!this.bot || !this.chatId || this.morningKickoffDone) return;
        this.refreshRoutine();
        this.morningKickoffDone = true;

        const name = this.routine.companion?.friendlyName || 'hey';
        const routine = this.getTodayRoutine();
        const pendingTasks = this.getPendingTasks();
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayName = days[new Date().getDay()];

        let msg = this.pick([
            `Rise and shine, ${name}! ☀️ Happy ${dayName}!`,
            `Good morning ${name}! 🌅 New day, let's make it count!`,
            `Heyyy ${name}! ☕ ${dayName} is here!`,
            `Morning ${name}! 🌤️ Ready to crush ${dayName}?`,
        ]) + '\n\n';

        if (routine.length > 0) {
            msg += `📅 Today's plan:\n`;
            routine.slice(0, 6).forEach(item => { msg += `  • ${item.time} — ${item.activity}\n`; });
            if (routine.length > 6) msg += `  ...and ${routine.length - 6} more\n`;
            msg += '\n';
        }

        if (pendingTasks.length > 0) {
            msg += `📌 Pending tasks (${pendingTasks.length}):\n`;
            pendingTasks.slice(0, 3).forEach(t => { msg += `  • ${t.text}${t.time ? ` ⏰${t.time}` : ''}\n`; });
            msg += '\n';
        }

        msg += this.pick([`What are you starting with? 💪`, `Where you kicking off from? 🚀`, `What's first on your list? 👊`]);

        try {
            await this.bot.sendMessage(this.chatId, msg);
            this.convState = 'waiting_reply';
            this.touchInteraction();
            console.log('[Companion] Morning kickoff sent');
        } catch (e) {
            console.error('[Companion] Failed to send morning kickoff:', e.message);
        }
    }

    // ─── CHECK-IN SCHEDULING ───────────────────────────────────────────────

    scheduleCheckIns() {
        this.checkInTimers.forEach(t => clearTimeout(t));
        this.checkInTimers = [];

        const config = this.routine.companion || {};
        if (!config.enabled) return;

        const count = config.checkInsPerDay || 6;
        const firstTime = config.firstCheckIn || '08:00';
        const lastTime = config.lastCheckIn || '22:00';

        const [firstH, firstM] = firstTime.split(':').map(Number);
        const [lastH, lastM] = lastTime.split(':').map(Number);
        const firstMin = firstH * 60 + firstM;
        const lastMin = lastH * 60 + lastM;
        const range = lastMin - firstMin;

        const checkInMinutes = [];
        for (let i = 1; i < count; i++) {
            const base = firstMin + (range / count) * i;
            const jitter = Math.floor(Math.random() * 30) - 15;
            checkInMinutes.push(Math.round(base + jitter));
        }
        checkInMinutes.sort((a, b) => a - b);

        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();

        for (const targetMin of checkInMinutes) {
            if (targetMin <= nowMin) continue;
            const delayMs = (targetMin - nowMin) * 60 * 1000;
            const timeStr = `${String(Math.floor(targetMin / 60)).padStart(2, '0')}:${String(targetMin % 60).padStart(2, '0')}`;
            console.log(`[Companion] Check-in at ${timeStr}`);
            this.checkInTimers.push(setTimeout(() => this.sendCheckIn(timeStr), delayMs));
        }

        console.log(`[Companion] ${this.checkInTimers.length} check-ins scheduled`);
    }

    async sendCheckIn(timeStr) {
        if (!this.bot || !this.chatId) return;
        this.refreshRoutine();

        const name = this.routine.companion?.friendlyName || 'hey';
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const routine = this.getTodayRoutine();
        const pendingTasks = this.getPendingTasks();

        let currentItem = null, nextItem = null;
        for (const item of routine) {
            const [h, m] = item.time.split(':').map(Number);
            const itemMin = h * 60 + m;
            if (itemMin <= nowMin) currentItem = item;
            if (itemMin > nowMin && !nextItem) nextItem = item;
        }

        const greeting = this.getTimeGreeting(now.getHours());
        let msg = this.pick([
            `${greeting}, ${name}! 👋 Quick check-in —`,
            `Yo ${name}! Just checking in 📋`,
            `Hey ${name}! 🕐 It's ${timeStr},`,
            `${greeting} ${name}! ⚡ Popping in —`,
            `Heyy ${name}! 😊`,
        ]) + ' ';

        if (currentItem) {
            msg += this.pick([
                `should be "${currentItem.activity}" time right now.`,
                `your routine says "${currentItem.activity}" — you on it?`,
                `you planned "${currentItem.activity}" around this time.`,
            ]) + '\n\n';
        } else {
            msg += `how's it going?\n\n`;
        }

        if (pendingTasks.length > 0 && Math.random() > 0.3) {
            const task = pendingTasks[Math.floor(Math.random() * Math.min(pendingTasks.length, 3))];
            msg += this.pick([
                `By the way, "${task.text}" is still pending 📌 — haven't forgotten have you? 😅`,
                `Also that "${task.text}" task is still on the list — any movement on that?`,
                `Don't forget "${task.text}" is waiting for you!`,
            ]) + '\n\n';
        }

        msg += this.pick([`What are you up to right now?`, `Tell me what you've been doing!`, `Drop me an update 🎯`, `How's it going so far?`, `What you working on?`]);

        if (nextItem && Math.random() > 0.5) {
            msg += `\n\n(Up next: ${nextItem.activity} at ${nextItem.time})`;
        }

        try {
            await this.bot.sendMessage(this.chatId, msg);
            this.convState = 'waiting_reply';
            this.touchInteraction();
            console.log(`[Companion] Check-in sent at ${timeStr}`);
        } catch (e) {
            console.error('[Companion] Check-in failed:', e.message);
        }
    }

    // ─── REPLY HANDLING ────────────────────────────────────────────────────

    async handleReply(text) {
        this.touchInteraction();
        const name = this.routine.companion?.friendlyName || 'hey';

        // Always check freeform commands first — even during conversation states
        // This ensures "tasks", "add task", "routine" always work regardless of state
        const freeform = this.handleFreeformChat(text);
        if (freeform !== null) {
            return freeform;
        }

        const logResult = this.logActivity(text);
        const comparison = this.getRoutineComparison(text);

        let response = '';

        if (this.convState === 'mood_check') {
            response = this.buildMoodResponse(text, name);
            this.convState = 'idle';
        } else if (this.convState === 'follow_up') {
            response = this.buildFollowUpAck(text, name);
            this.convState = 'idle';
        } else {
            response = this.buildCheckInReply(text, logResult, comparison, name);
            const followUp = this.buildFollowUp(text, name);
            if (followUp) {
                response += '\n\n' + followUp.message;
                this.lastFollowUpContext = followUp.context;
                this.convState = followUp.context ? 'follow_up' : 'idle';
            } else {
                this.convState = 'idle';
            }
        }

        return response;
    }

    buildCheckInReply(text, logResult, comparison, name) {
        let reply = this.pick([`Got it, noted! ✅`, `Nice, logged that 📝`, `Logged! ✅`, `Cool, I've got that down ✨`]);

        if (comparison) {
            if (comparison.isOnTrack) {
                reply += ' ' + this.pick([
                    `You're right on track with "${comparison.expected.activity}" 💪`,
                    `That lines up perfectly with your schedule 🎯`,
                    `Exactly where you should be! 🔥`,
                ]);
            } else if (comparison.deviation > 60) {
                reply += '\n' + this.pick([
                    `Heads up — routine had "${comparison.expected.activity}" scheduled. No stress, just a nudge 😊`,
                    `FYI your plan said "${comparison.expected.activity}" around now. Still time!`,
                ]);
            }
        }

        if (Math.random() < 0.4) {
            reply += `\n(Day log: ${logResult.totalToday} ${logResult.totalToday === 1 ? 'entry' : 'entries'} so far)`;
        }

        return reply;
    }

    buildFollowUp(replyText, name) {
        this.refreshRoutine();
        const pendingTasks = this.getPendingTasks();
        const hotseat = this.getHotseatRoutineItems();
        const lower = replyText.toLowerCase();

        const unmentionedTask = pendingTasks.find(t => {
            const words = t.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            return !words.some(w => lower.includes(w));
        });

        if (unmentionedTask && Math.random() > 0.4) {
            return {
                message: this.pick([
                    `Hey btw — "${unmentionedTask.text}" is still pending. You getting to that today?`,
                    `Also, "${unmentionedTask.text}" hasn't been touched yet. On your radar? 📌`,
                ]),
                context: `task:${unmentionedTask.text}`
            };
        }

        const unmentionedRoutine = hotseat.find(item => {
            const words = item.activity.toLowerCase().split(/[\s\/]+/).filter(w => w.length > 3);
            return !words.some(w => lower.includes(w));
        });

        if (unmentionedRoutine && Math.random() > 0.5) {
            return {
                message: `Quick one — "${unmentionedRoutine.activity}" is up soon (${unmentionedRoutine.time}). You planning on it? 📅`,
                context: `routine:${unmentionedRoutine.activity}`
            };
        }

        if (Math.random() > 0.5) {
            return {
                message: this.pick([`Keep it up ${name}! 🔥`, `You're doing great! 💪`, `Solid! Drop me another update later 😊`]),
                context: null
            };
        }

        return null;
    }

    buildFollowUpAck(text, name) {
        const lower = text.toLowerCase();
        if (/yes|yeah|yep|sure|will|gonna|on it|doing|okay|ok/i.test(lower)) {
            return this.pick([`Awesome! 🙌 You've got this!`, `Love that energy! 🔥`, `Nice! Keep me posted 😊`]);
        }
        if (/no|nah|nope|can't|later|maybe/i.test(lower)) {
            return this.pick([`No worries! Just keeping you in the loop 😊`, `Fair enough! You do you! 👍`]);
        }
        return this.pick([`Got it! 👍`, `Noted! Keep it up ${name} 🌟`]);
    }

    buildMoodResponse(text, name) {
        this.logActivity(`Mood: ${text}`);
        const lower = text.toLowerCase();

        if (/good|great|amazing|awesome|happy|excited|motivated|productive/i.test(lower)) {
            return this.pick([
                `That's what I like to hear! 😄 Let's ride that wave ${name}!`,
                `Love it! Channel that energy 🔥`,
                `Amazing! You're on fire today 🌟`,
            ]);
        }
        if (/bad|tired|sad|stress|anxious|meh|rough|bored|sleepy|lazy/i.test(lower)) {
            return this.pick([
                `Take it easy on yourself ${name}. Even small progress counts! 😔💙`,
                `Rough patches happen — you're still showing up, that matters 💙`,
                `Even on off days, you're still going. That takes strength! 🫂`,
            ]);
        }
        return this.pick([`Fair enough! Keep moving forward ${name} 🚶`, `Some days are just like that — you've got this 💫`]);
    }

    // ─── MOOD CHECK ────────────────────────────────────────────────────────

    async sendMoodCheck() {
        if (!this.bot || !this.chatId) return;
        const name = this.routine?.companion?.friendlyName || 'hey';
        const msg = this.pick([
            `Hey ${name}, how are you actually feeling right now? 🌡️`,
            `Checking in on you ${name} — how's the vibe today? 😊`,
            `${name}! How are you feeling? Any stress, or all good? 💙`,
        ]);
        try {
            await this.bot.sendMessage(this.chatId, msg);
            this.convState = 'mood_check';
            this.touchInteraction();
        } catch (e) {
            console.error('[Companion] Mood check failed:', e.message);
        }
    }

    // ─── REMINDERS ─────────────────────────────────────────────────────────

    scheduleReminders() {
        this.reminderTimers.forEach(t => clearTimeout(t));
        this.reminderTimers = [];

        const reminders = this.routine.reminders || [];
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const today = now.toISOString().split('T')[0];

        for (const reminder of reminders) {
            if (reminder.date && reminder.date !== today) continue;
            const [h, m] = (reminder.time || '09:00').split(':').map(Number);
            const targetMin = h * 60 + m;
            if (targetMin <= nowMin) continue;

            const delayMs = (targetMin - nowMin) * 60 * 1000;
            this.reminderTimers.push(setTimeout(async () => {
                if (this.bot && this.chatId) {
                    await this.bot.sendMessage(this.chatId, `⏰ Reminder: ${reminder.text}${reminder.note ? `\n📝 ${reminder.note}` : ''}`);
                }
            }, delayMs));
        }

        if (this.reminderTimers.length > 0) console.log(`[Companion] ${this.reminderTimers.length} reminders scheduled`);
    }

    // ─── END-OF-DAY SUMMARY ────────────────────────────────────────────────

    scheduleSummary() {
        const summaryTime = this.routine.companion?.summaryTime || '22:30';
        const [h, m] = summaryTime.split(':').map(Number);
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const targetMin = h * 60 + m;
        if (targetMin <= nowMin) return;

        setTimeout(async () => {
            const summary = await this.generateDaySummary();
            if (this.bot && this.chatId) await this.bot.sendMessage(this.chatId, summary);
        }, (targetMin - nowMin) * 60 * 1000);

        console.log(`[Companion] Summary at ${summaryTime}`);
    }

    async generateDaySummary() {
        const logs = this.getTodayLogs();
        const routine = this.getTodayRoutine();
        const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const name = this.routine.companion?.friendlyName || 'hey';

        let summary = `🌙 Day Wrap-up — ${dateStr}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        if (logs.length === 0) {
            summary += `No activities logged today ${name}. Tomorrow — let's stay on it! 💪\n`;
            return summary;
        }

        summary += `📋 Activities logged: ${logs.length}\n`;
        logs.forEach((log, i) => { summary += `  ${i + 1}. ${log.time} — ${log.activity}\n`; });

        if (routine.length > 0) {
            const logsStr = logs.map(l => l.activity.toLowerCase()).join(' ');
            let matched = 0;
            const missed = [];
            for (const item of routine) {
                const words = item.activity.toLowerCase().split(/[\s\/]+/).filter(w => w.length > 3);
                if (words.some(w => logsStr.includes(w))) matched++;
                else missed.push(item.activity);
            }

            const pct = Math.round((matched / routine.length) * 100);
            summary += `\n✅ Routine completion: ${matched}/${routine.length} (${pct}%)\n`;
            if (missed.length > 0 && missed.length <= 5) summary += `❌ Possibly missed: ${missed.join(', ')}\n`;

            if (pct >= 80) summary += `\n🔥 Crushed it today ${name}!\n`;
            else if (pct >= 50) summary += `\n👍 Solid day! More than halfway.\n`;
            else summary += `\n💡 Tomorrow is a fresh start!\n`;
        }

        const pending = this.getPendingTasks();
        if (pending.length > 0) {
            summary += `\n📌 Pending tasks: ${pending.length}\n`;
            pending.slice(0, 3).forEach(t => { summary += `  • ${t.text}\n`; });
        }

        summary += '\n' + this.pick([`Rest up and come back stronger 🔋`, `Every day is a step forward 🧱`, `Proud of you! 💪`]);
        return summary;
    }

    // ─── UTILITY ───────────────────────────────────────────────────────────

    pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    getTimeGreeting(hour) {
        if (hour < 6) return '🌙 Up late';
        if (hour < 12) return '☀️ Good morning';
        if (hour < 17) return '🌤️ Good afternoon';
        if (hour < 21) return '🌆 Good evening';
        return '🌙 Hey';
    }

    getRoutineFormatted() {
        this.refreshRoutine();
        const routine = this.getTodayRoutine();
        if (routine.length === 0) return 'No routine set for today.';

        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const today = days[new Date().getDay()];
        const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

        let text = `📅 Your ${today} Routine:\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const item of routine) {
            const [h, m] = item.time.split(':').map(Number);
            const marker = (h * 60 + m) <= nowMin ? '✅' : '⬜';
            const isCurrent = Math.abs((h * 60 + m) - nowMin) < 30 ? ' ← now' : '';
            text += `${marker} ${item.time} — ${item.activity}${isCurrent}\n`;
        }
        return text;
    }

    getTasksFormatted() {
        this.refreshRoutine();
        const tasks = this.routine.tasks || [];
        if (tasks.length === 0) return 'No tasks yet! Use /addtask to create one 📌';

        let text = '📌 Your Tasks:\n━━━━━━━━━━━━━━━━━━━━━━\n';
        tasks.forEach((t, i) => {
            text += `${t.completed ? '✅' : '⬜'} ${i + 1}. ${t.text}${t.time ? ` (${t.time})` : ''}\n`;
        });
        const pending = tasks.filter(t => !t.completed).length;
        text += `\n${pending} pending, ${tasks.length - pending} done`;
        return text;
    }

    addTask(text, time = null) {
        this.refreshRoutine();
        if (!this.routine.tasks) this.routine.tasks = [];
        this.routine.tasks.push({ text, time, completed: false, createdAt: Date.now() });
        this.saveRoutine();
        return `✅ Task added: "${text}"${time ? ` at ${time}` : ''}\n\nI'll keep you accountable! 💪`;
    }

    completeTask(index) {
        this.refreshRoutine();
        const tasks = this.routine.tasks || [];
        if (index < 0 || index >= tasks.length) return '❌ Invalid task number.';
        tasks[index].completed = true;
        this.saveRoutine();
        return this.pick([`✅ Done: "${tasks[index].text}" 🔥`, `✅ "${tasks[index].text}" checked off! 🙌`]);
    }

    addReminder(text, time, date = null) {
        this.refreshRoutine();
        if (!this.routine.reminders) this.routine.reminders = [];
        this.routine.reminders.push({ text, time, date, createdAt: Date.now() });
        this.saveRoutine();
        this.scheduleReminders();
        return `⏰ Reminder set: "${text}" at ${time}${date ? ` on ${date}` : ''} 📲`;
    }

    saveRoutine() {
        try {
            fs.writeFileSync(ROUTINE_FILE, JSON.stringify(this.routine, null, 2));
            // Push to JSONBin so Mac app picks it up
            this.pushToCloud().catch(() => {});
        } catch (e) {
            console.error('[Companion] Save failed:', e.message);
        }
    }

    stop() {
        this.checkInTimers.forEach(t => clearTimeout(t));
        this.reminderTimers.forEach(t => clearTimeout(t));
        this.checkInTimers = [];
        this.reminderTimers = [];
        console.log('[Companion] Stopped');
    }

    get waitingForReply() {
        return this.convState === 'waiting_reply' || this.convState === 'follow_up';
    }
}

module.exports = new CompanionService();
