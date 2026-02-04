import { Page, BrowserContext, Locator } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { AccountConfig, SettingsConfig, BehaviorConfig } from './config';
import { HumanBehavior, PauseState } from './humanBehavior';
import { Logger } from './logger';
import { AICommentGenerator } from './genai';

export type InteractionResult = 'SUCCESS' | 'SKIPPED' | 'FAILED';

interface MentionNotification {
    key: string;
    postUrl: string;
    commenterUsername?: string;
    commentText?: string;
}

export class InstagramBot {
    private context!: BrowserContext;
    private page!: Page;
    private readonly config: AccountConfig;
    private readonly cookiePath: string;
    private readonly actionDelays: { min: number; max: number };
    private readonly behavior: BehaviorConfig;
    private readonly pauseState: PauseState;
    private readonly globalLogPath: string;
    private readonly mentionSeenPath: string;
    private seenMentionKeys: Set<string> = new Set();
    private humanBehavior!: HumanBehavior;
    private readonly developerMode: boolean;
    private readonly logger: Logger;
    private readonly aiGenerator: AICommentGenerator;
    private capturedVideoUrl: string | undefined = undefined;
    private isCapturingVideo: boolean = false;
    private readonly logsDir: string;

    constructor(
        accountConfig: AccountConfig,
        globalSettings: SettingsConfig,
        pauseState: PauseState,
        logger: Logger,
        aiGenerator: AICommentGenerator
    ) {
        this.config = accountConfig;
        this.behavior = globalSettings.behavior;
        this.cookiePath = path.join(__dirname, '..', 'data', 'cookies', `${this.config.username}.json`);
        this.globalLogPath = path.join(__dirname, '..', 'data', 'logs', 'interaction_log.csv');
        this.mentionSeenPath = path.join(__dirname, '..', 'data', 'logs', `mentions_seen_${this.config.username}.json`);
        this.logsDir = path.join(__dirname, '..', 'data', 'logs');
        this.pauseState = pauseState;
        this.developerMode = globalSettings.developerMode;
        this.logger = logger;
        this.aiGenerator = aiGenerator;

        if (this.developerMode) {
            this.actionDelays = { min: 1000, max: 2000 };
            this.logger.debug('Developer mode is ON. Using short action delays.');
        } else {
            const actionDelay = accountConfig.actionDelaySeconds ?? globalSettings.defaultActionDelaySeconds;
            this.actionDelays = {
                min: actionDelay.min * 1000,
                max: actionDelay.max * 1000,
            };
            this.logger.info(`Action delay loaded: ${actionDelay.min}s - ${actionDelay.max}s`);
        }

        this.loadSeenMentions();
    }

    private async logInteraction(targetUsername: string, actionType: 'comment' | 'reply', comment: string) {
        const timestamp = new Date().toISOString();
        const sanitizedComment = `"${comment.replace(/"/g, '""')}"`;
        const logEntry = `${timestamp},${this.config.username},${targetUsername},${actionType},${sanitizedComment}\n`;

        if (actionType === 'comment') {
            this.logger.incrementComments();
        }

        try {
            fs.appendFileSync(this.globalLogPath, logEntry, 'utf-8');
        } catch (error: any) {
            this.logger.error(`Failed to write to global CSV log: ${error.message}`);
        }
    }

    private loadSeenMentions() {
        try {
            if (!fs.existsSync(this.mentionSeenPath)) {
                fs.writeFileSync(this.mentionSeenPath, JSON.stringify([], null, 2));
                this.seenMentionKeys = new Set();
                return;
            }

            const raw = fs.readFileSync(this.mentionSeenPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                this.seenMentionKeys = new Set(parsed.filter((item: any) => typeof item === 'string'));
            } else {
                this.seenMentionKeys = new Set();
            }
        } catch (error: any) {
            this.logger.warn(`Failed to load mentions seen file. Starting fresh. Error: ${error.message}`);
            this.seenMentionKeys = new Set();
            fs.writeFileSync(this.mentionSeenPath, JSON.stringify([], null, 2));
        }
    }

    private persistSeenMentions() {
        try {
            const keys = Array.from(this.seenMentionKeys);
            fs.writeFileSync(this.mentionSeenPath, JSON.stringify(keys, null, 2));
        } catch (error: any) {
            this.logger.warn(`Failed to persist mentions seen file: ${error.message}`);
        }
    }

    private buildMentionKey(postUrl: string, commenterUsername?: string, commentText?: string): string {
        const raw = `${postUrl}|${commenterUsername ?? ''}|${commentText ?? ''}`;
        return createHash('sha1').update(raw).digest('hex');
    }

    private markMentionSeen(key: string) {
        this.seenMentionKeys.add(key);
        this.persistSeenMentions();
    }

    private async ensureCookiesAreSaved() {
        if (!fs.existsSync(this.cookiePath)) {
            this.logger.action('Session is active but cookie file is missing. Saving now...');
            try {
                await this.context.storageState({ path: this.cookiePath });
                this.logger.success(`Cookies saved successfully.`);
            } catch (e: any) {
                this.logger.error(`Failed to save cookies: ${e.message}`);
            }
        }
    }

    public getPage(): Page {
        return this.page;
    }

    public async init(context: BrowserContext) {
        this.context = context;
        this.page = await this.context.newPage();
        this.humanBehavior = new HumanBehavior(this.page, this.developerMode, this.pauseState, this.logger);

        this.page.on('response', async response => {
            try {
                if (!this.isCapturingVideo) return;

                if (this.capturedVideoUrl) return;

                const url = response.url();
                const contentType = response.headers()['content-type'];

                if (
                    contentType &&
                    contentType.includes('video/mp4') &&
                    url.includes('fbcdn.net') &&
                    (url.includes('instagram') || url.includes('ig'))
                ) {
                    this.capturedVideoUrl = url;
                    this.logger.info(`Captured video URL: ${url.substring(0, 80)}...`);
                }
            } catch (e) {}
        });

        this.logger.action('Navigating to Instagram...');
        await this.page.goto('https://www.instagram.com/?hl=en');
        await this.humanBehavior.randomizedWait(this.behavior.navigationWaitMs);

        await this.humanBehavior.moveMouseRandomly();
        this.logger.info('Checking login status...');

        try {
            await this.dismissCommonPopups();
            if (await this.checkIfLoggedIn()) {
                this.logger.success('Already logged in.');
                await this.ensureCookiesAreSaved();
                return true;
            } else {
                this.logger.info('Not logged in. Performing login.');
                await this.login();
                return true;
            }
        } catch (e: any) {
            this.logger.error(`Error during init: ${e.message}. Attempting login...`);
            await this.login();
            return true;
        }
    }

    private async checkIfLoggedIn(): Promise<boolean> {
        try {
            const profileLink = this.page.locator(`a[href="/${this.config.username}/"]`);
            if ((await profileLink.count()) > 0) return true;

            const homeIcon = this.page.locator('svg[aria-label="Home"]');
            if ((await homeIcon.count()) > 0) return true;

            const usernameInput = this.page.locator(
                [
                    'input[name="username"]',
                    'input[autocomplete="username"]',
                    'input[aria-label*="username" i]',
                    'input[aria-label*="phone" i]',
                    'input[aria-label*="email" i]',
                ].join(',')
            );
            if ((await usernameInput.count()) > 0) return false;

            return false;
        } catch (e: any) {
            this.logger.error(`Error checking login status: ${e.message}`);
            return false;
        }
    }

    private async dismissCommonPopups() {
        try {
            const allowCookiesButton = this.page.getByRole('button', { name: 'Allow all cookies' });
            if ((await allowCookiesButton.count()) > 0) {
                this.logger.action('Dismissing "Allow all cookies" popup...');
                await this.humanBehavior.hesitateAndClick(allowCookiesButton);
                await this.humanBehavior.randomizedWait(this.behavior.shortWaitMs);
            }
        } catch (e) {}

        try {
            const saveInfoButton = this.page.getByRole('button', { name: 'Save Info' });
            if ((await saveInfoButton.count()) > 0) {
                this.logger.action('Dismissing "Save Info" popup...');
                await this.humanBehavior.hesitateAndClick(saveInfoButton);
                await this.humanBehavior.randomizedWait(this.behavior.shortWaitMs);
            }
        } catch (e) {}

        try {
            const notNowButton = this.page.getByRole('button', { name: 'Not Now' });
            if ((await notNowButton.count()) > 0) {
                this.logger.action('Dismissing "Turn on Notifications" popup...');
                await this.humanBehavior.hesitateAndClick(notNowButton.first());
                await this.humanBehavior.randomizedWait(this.behavior.shortWaitMs);
            }
        } catch (e) {}
    }

    private async resolveLoginInputs(): Promise<{
        scope: Page | Locator;
        usernameInput: Locator;
        passwordInput: Locator;
    }> {
        const loginForm = this.page.locator('form').filter({ has: this.page.locator('input[type="password"]') }).first();
        const hasForm = (await loginForm.count()) > 0;
        const scope: Page | Locator = hasForm ? loginForm : this.page;

        const strictUsernameSelectors = [
            'input[name="username"]',
            'input[autocomplete="username"]',
            'input[aria-label*="username" i]',
            'input[aria-label*="phone" i]',
            'input[aria-label*="email" i]',
        ].join(',');
        const relaxedUsernameSelectors = `${strictUsernameSelectors}, input[type="text"], input[type="email"]`;
        const usernameSelectors = hasForm ? relaxedUsernameSelectors : strictUsernameSelectors;

        const passwordSelectors = [
            'input[name="password"]',
            'input[autocomplete="current-password"]',
            'input[aria-label*="password" i]',
            'input[type="password"]',
        ].join(',');

        return {
            scope,
            usernameInput: scope.locator(usernameSelectors).first(),
            passwordInput: scope.locator(passwordSelectors).first(),
        };
    }

    private async login() {
        const initialLoginInputs = await this.resolveLoginInputs();
        if ((await initialLoginInputs.usernameInput.count()) === 0) {
            this.logger.action('Navigating to login page...');
            await this.page.goto('https://www.instagram.com/accounts/login/?hl=en', {
                waitUntil: 'domcontentloaded',
            });
            await this.humanBehavior.randomizedWait(this.behavior.navigationWaitMs);
            await this.humanBehavior.moveMouseRandomly();
        }

        await this.dismissCommonPopups();

        const { scope, usernameInput, passwordInput } = await this.resolveLoginInputs();

        try {
            await usernameInput.waitFor({ timeout: 15000, state: 'visible' });
        } catch (e) {
            await this.page.screenshot({ path: path.join(this.logsDir, `login_page_error_${this.config.username}.png`) });
            if (await this.checkIfLoggedIn()) {
                this.logger.success('Detected that we are already logged in!');
                await this.ensureCookiesAreSaved();
                return;
            }
            const currentUrl = this.page.url();
            const pageTitle = await this.page.title();
            this.logger.warn(`Login page missing username input. url=${currentUrl} title="${pageTitle}"`);
            throw new Error('Could not find username input on login page');
        }

        this.logger.action('Typing credentials...');
        await this.humanBehavior.randomizedWait(this.behavior.shortWaitMs);

        await this.humanBehavior.naturalTyping(usernameInput, this.config.username, {
            min: 80,
            max: 250,
            typoChance: 0.07,
        });

        await this.humanBehavior.randomDelay(500, 1500);

        await this.humanBehavior.naturalTyping(passwordInput, this.config.password, {
            min: 100,
            max: 300,
            typoChance: 0.03,
        });

        this.logger.action('Submitting login form...');
        await this.humanBehavior.randomDelay(800, 2000);

        let loginButton = scope.getByRole('button', { name: /log in|sign in/i }).first();
        if ((await loginButton.count()) === 0) {
            loginButton = scope.locator('button[type="submit"], input[type="submit"]').first();
        }
        await this.humanBehavior.hesitateAndClick(loginButton);

        try {
            const saveInfoButton = this.page.getByRole('button', { name: 'Save info' });
            await saveInfoButton.waitFor({ timeout: 8000 });
            this.logger.action('Saving login info...');
            await this.humanBehavior.randomDelay(500, 1500);
            await this.humanBehavior.hesitateAndClick(saveInfoButton);
            await this.humanBehavior.randomizedWait(this.behavior.navigationWaitMs);
        } catch (e) {}

        try {
            const profileLinkSelector = `a[href="/${this.config.username}/"]`;
            await this.page.waitForSelector(profileLinkSelector, { timeout: 15000, state: 'visible' });
        } catch (error) {
            const screenshotPath = path.join(this.logsDir, `login_error_${this.config.username}.png`);
            await this.page.screenshot({ path: screenshotPath });
            throw new Error(`Login failed. Screenshot saved to: ${screenshotPath}`);
        }

        await this.dismissCommonPopups();
        this.logger.action('Saving cookies to disk...');
        await this.context.storageState({ path: this.cookiePath });
    }

    private async collectMentionNotifications(): Promise<MentionNotification[]> {
        const notifications: MentionNotification[] = [];

        this.logger.action('Navigating to activity feed to check mentions...');
        await this.page.goto('https://www.instagram.com/accounts/activity/?hl=en');
        await this.humanBehavior.randomizedWait(this.behavior.navigationWaitMs);
        await this.dismissCommonPopups();

        const mainFeed = this.page.locator('main');
        await mainFeed.waitFor({ state: 'visible', timeout: 15000 });

        const mentionItems = mainFeed.locator('li').filter({ hasText: /mentioned you.*comment/i });
        const mentionCount = await mentionItems.count();

        if (mentionCount === 0) {
            this.logger.info('No mention notifications found.');
            return notifications;
        }

        this.logger.info(`Found ${mentionCount} mention notification(s).`);

        for (let i = 0; i < mentionCount; i++) {
            const item = mentionItems.nth(i);
            const itemText = (await item.innerText()).replace(/\s+/g, ' ').trim();

            const postLink = item.locator('a[href*="/p/"], a[href*="/reel/"]').first();
            const href = await postLink.getAttribute('href');
            if (!href) {
                this.logger.warn('Mention item missing post link. Skipping.');
                continue;
            }

            const postUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;

            let commenterUsername: string | undefined;
            const profileLink = item
                .locator('a[href^="/"]')
                .filter({ hasNot: item.locator('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]') })
                .first();
            const profileHref = await profileLink.getAttribute('href');
            if (profileHref) {
                commenterUsername = profileHref.split('/').filter(Boolean)[0];
            }

            let commentText: string | undefined;
            const mentionMatch = itemText.match(/mentioned you.*comment:? (.*)$/i);
            if (mentionMatch && mentionMatch[1]) {
                commentText = mentionMatch[1].trim();
                commentText = commentText.replace(/\s*[·•]?\s*\d+[smhdwy]\b.*$/i, '').trim();
            }

            const key = this.buildMentionKey(postUrl, commenterUsername, commentText);
            notifications.push({
                key,
                postUrl,
                commenterUsername,
                commentText,
            });
        }

        return notifications;
    }

    private async resolvePostRoot(): Promise<Locator> {
        const dialog = this.page.locator('div[role="dialog"]');
        if ((await dialog.count()) > 0) {
            return dialog.first();
        }

        const article = this.page.locator('article');
        await article.first().waitFor({ state: 'visible', timeout: 15000 });
        return article.first();
    }

    private async extractPostOwner(root: Locator): Promise<string> {
        try {
            const headerLink = root.locator('header a[href^="/"]').first();
            if ((await headerLink.count()) > 0) {
                const href = await headerLink.getAttribute('href');
                if (href) {
                    return href.split('/').filter(Boolean)[0];
                }
            }
        } catch (e) {}
        return 'unknown';
    }

    private async extractPostCaption(root: Locator): Promise<string> {
        const captionCandidates = [
            root.locator('h1').first(),
            this.page.locator('h1').first(),
        ];

        for (const candidate of captionCandidates) {
            try {
                if ((await candidate.count()) > 0 && (await candidate.isVisible({ timeout: 2000 }))) {
                    const text = await candidate.textContent();
                    if (text) return text.trim();
                }
            } catch (e) {}
        }

        return '';
    }

    private async extractPostMedia(root: Locator): Promise<{ imageUrl?: string; videoUrl?: string; isVideo: boolean }> {
        let imageUrl: string | undefined;
        let videoUrl: string | undefined;
        let isVideo = false;

        try {
            const videoErrorMessage = root.getByText("Sorry, we're having trouble playing this video");
            const videoElement = root.locator('video');

            if ((await videoErrorMessage.count()) > 0 || (await videoElement.count()) > 0) {
                isVideo = true;

                if (this.capturedVideoUrl) {
                    videoUrl = this.capturedVideoUrl;
                } else {
                    const src = await videoElement.first().getAttribute('src');
                    if (src) videoUrl = src;
                }

                const poster = await videoElement.first().getAttribute('poster');
                if (poster) {
                    imageUrl = poster;
                }
            } else {
                const imageLocators = [
                    root.locator('img[src*="instagram"]').first(),
                    root.locator('img[alt]').first(),
                    root.locator('article img').first(),
                ];

                for (const imageLocator of imageLocators) {
                    if ((await imageLocator.count()) > 0 && (await imageLocator.isVisible({ timeout: 2000 }))) {
                        const src = await imageLocator.getAttribute('src');
                        if (src && !src.includes('static') && !src.includes('sprite')) {
                            imageUrl = src;
                            break;
                        }
                    }
                }
            }

            if (!imageUrl) {
                const fallbackImages = [
                    root.locator('img[src*="instagram"]').first(),
                    root.locator('img[alt]').first(),
                    root.locator('article img').first(),
                ];

                for (const imageLocator of fallbackImages) {
                    if ((await imageLocator.count()) > 0 && (await imageLocator.isVisible({ timeout: 2000 }))) {
                        const src = await imageLocator.getAttribute('src');
                        if (src && !src.includes('static') && !src.includes('sprite')) {
                            imageUrl = src;
                            break;
                        }
                    }
                }
            }
        } catch (e) {
            this.logger.warn('Could not extract post media.');
        }

        return { imageUrl, videoUrl, isVideo };
    }

    private async findMentionComment(root: Locator, mentionText?: string): Promise<Locator | null> {
        let searchRoot = root;

        const viewAllComments = root.getByText(/View all \d+ comments/i);
        if ((await viewAllComments.count()) > 0) {
            try {
                await this.humanBehavior.hesitateAndClick(viewAllComments.first());
                await this.humanBehavior.randomizedWait(this.behavior.shortWaitMs);
                const dialog = this.page.locator('div[role="dialog"]');
                if ((await dialog.count()) > 0) {
                    searchRoot = dialog.first();
                }
            } catch (e) {}
        }

        let candidate = searchRoot.locator('ul li').filter({ hasText: `@${this.config.username}` });

        if (mentionText) {
            const snippet = mentionText.slice(0, 40);
            candidate = candidate.filter({ hasText: snippet });
        }

        if ((await candidate.count()) === 0 && mentionText) {
            candidate = searchRoot.locator('ul li').filter({ hasText: mentionText });
        }

        if ((await candidate.count()) === 0) {
            return null;
        }

        return candidate.first();
    }

    private async replyToMention(mention: MentionNotification): Promise<InteractionResult> {
        try {
            if (mention.commenterUsername && mention.commenterUsername === this.config.username) {
                this.logger.info('Skipping mention from our own account.');
                return 'SKIPPED';
            }

            this.capturedVideoUrl = undefined;
            this.isCapturingVideo = true;

            this.logger.action(`Opening post from mention: ${mention.postUrl}`);
            await this.page.goto(mention.postUrl);
            await this.humanBehavior.randomizedWait(this.behavior.navigationWaitMs);

            const root = await this.resolvePostRoot();
            const postOwner = await this.extractPostOwner(root);

            const postCaption = await this.extractPostCaption(root);
            if (postCaption) {
                this.logger.info(`Found caption: "${postCaption.substring(0, 50)}..."`);
            } else {
                this.logger.info('No caption found on this post.');
            }

            const media = await this.extractPostMedia(root);
            if (media.isVideo) {
                this.logger.info('Detected video post.');
            }

            this.logger.action('Locating mentioned comment...');
            const mentionComment = await this.findMentionComment(root, mention.commentText);
            if (!mentionComment) {
                this.logger.warn('Could not locate the mentioned comment. Skipping.');
                return 'SKIPPED';
            }

            await mentionComment.hover().catch(() => {});

            let replyButton = mentionComment.locator('button', { hasText: /Reply/i }).first();
            if ((await replyButton.count()) === 0) {
                replyButton = mentionComment.getByText('Reply', { exact: true });
            }

            if ((await replyButton.count()) === 0) {
                this.logger.warn('Reply button not found for mention. Skipping.');
                return 'SKIPPED';
            }

            await this.humanBehavior.hesitateAndClick(replyButton);
            await this.humanBehavior.randomDelay(800, 1600);

            this.logger.action('Generating AI reply...');
            const aiReply = await this.aiGenerator.generateInstagramReply(
                postCaption,
                postOwner,
                mention.commentText,
                mention.commenterUsername,
                this.config.aiPromptHint,
                media.imageUrl,
                media.videoUrl
            );

            this.logger.success(`AI Generated Reply: "${aiReply}"`);

            const commentTextarea = this.page.locator('textarea[aria-label*="Add a comment"]');
            if ((await commentTextarea.count()) === 0) {
                this.logger.warn('Reply textarea not found. Comments might be disabled.');
                return 'SKIPPED';
            }

            await this.humanBehavior.jitteryMovement(commentTextarea);
            await this.humanBehavior.randomDelay(1000, 3000);

            this.logger.action('Typing reply...');
            await this.humanBehavior.naturalTyping(commentTextarea, aiReply);
            await this.humanBehavior.randomDelay(1500, 4000);

            const postButton = this.page.locator('form').getByRole('button', { name: 'Post' });
            if ((await postButton.count()) === 0 || !(await postButton.isEnabled())) {
                this.logger.error('Could not find an enabled "Post" button for reply.');
                return 'FAILED';
            }

            this.logger.action('Submitting reply...');
            await this.humanBehavior.hesitateAndClick(postButton);
            await this.humanBehavior.randomDelay(4000, 7000);

            await this.logInteraction(mention.commenterUsername || postOwner, 'reply', aiReply);
            this.logger.success('Successfully replied to mention.');
            return 'SUCCESS';
        } catch (error: any) {
            this.logger.error(`Failed to reply to mention: ${error.message}`);
            return 'FAILED';
        } finally {
            this.isCapturingVideo = false;
        }
    }

    public async runMentionReplyTask(): Promise<void> {
        this.logger.header(`----- Checking mention replies for @${this.config.username} -----`);

        const notifications = await this.collectMentionNotifications();
        if (notifications.length === 0) return;

        let replied = 0;
        let skipped = 0;
        let failed = 0;

        for (const mention of notifications) {
            if (this.seenMentionKeys.has(mention.key)) {
                continue;
            }

            const result = await this.replyToMention(mention);

            if (result !== 'FAILED') {
                this.markMentionSeen(mention.key);
            }

            if (result === 'SUCCESS') replied++;
            if (result === 'SKIPPED') skipped++;
            if (result === 'FAILED') failed++;

            await this.humanBehavior.randomDelay(this.actionDelays.min, this.actionDelays.max);
        }

        this.logger.info(`Mention cycle complete. Replied: ${replied}, Skipped: ${skipped}, Failed: ${failed}.`);
    }

    public async runCommentTask(targetUsername: string, aiPromptHint?: string): Promise<InteractionResult> {
        this.logger.header(`----- Starting Comment Task for @${targetUsername} -----`);

        try {
            this.capturedVideoUrl = undefined;
            this.isCapturingVideo = false;

            this.logger.action(`Navigating to @${targetUsername}'s profile page...`);
            await this.page.goto(`https://www.instagram.com/${targetUsername}/?hl=en`);
            await this.humanBehavior.randomizedWait(this.behavior.navigationWaitMs);

            const isPrivate = (await this.page.getByText('This Account Is Private').count()) > 0;
            if (isPrivate) {
                this.logger.warn(`@${targetUsername} is private. Cannot comment on posts.`);
                return 'SKIPPED';
            }

            this.logger.action(`Looking for the latest, non-pinned post...`);
            const allPostLinks = this.page.locator('main a[href*="/p/"], main a[href*="/reel/"]');

            const nonPinnedPostLinks = allPostLinks.filter({
                hasNot: this.page.locator('svg[aria-label="Pinned post icon"]'),
            });

            const postCount = await nonPinnedPostLinks.count();

            if (postCount === 0) {
                if ((await allPostLinks.count()) > 0) {
                    this.logger.warn(
                        `Could not find any non-pinned posts on @${targetUsername}'s profile. All visible posts may be pinned. Skipping.`
                    );
                } else {
                    this.logger.warn(`Could not find any posts on @${targetUsername}'s profile. Skipping.`);
                }
                await this.page.screenshot({ path: path.join(this.logsDir, `no_posts_error_${this.config.username}_${targetUsername}.png`) });
                return 'SKIPPED';
            }

            const latestPost = nonPinnedPostLinks.first();
            this.logger.action(`Opening latest post...`);

            this.isCapturingVideo = true;

            await this.humanBehavior.hesitateAndClick(latestPost);

            const dialogSelector = 'div[role="dialog"]';
            await this.page.waitForSelector(dialogSelector, { state: 'visible', timeout: 15000 });
            this.logger.success(`Post opened in a dialog.`);
            await this.humanBehavior.randomizedWait(this.behavior.shortWaitMs);

            this.logger.action('Extracting post caption...');
            const captionLocator = this.page.locator('div[role="dialog"] h1').first();
            let postCaption = '';
            try {
                if (await captionLocator.isVisible({ timeout: 2000 })) {
                    postCaption = (await captionLocator.textContent()) || '';
                    this.logger.info(`Found caption: "${postCaption.substring(0, 50)}..."`);
                } else {
                    this.logger.info('No caption found on this post.');
                }
            } catch (e) {
                this.logger.warn('Could not extract post caption.');
            }

            this.logger.action('Extracting post media (image/video)...');
            let postImageUrl: string | undefined;
            let postVideoUrl: string | undefined;
            let isVideoPost = false;

            try {
                const videoErrorMessage = this.page
                    .locator('div[role="dialog"]')
                    .getByText("Sorry, we're having trouble playing this video");
                const videoElement = this.page.locator('div[role="dialog"] video');

                if ((await videoErrorMessage.count()) > 0 || (await videoElement.count()) > 0) {
                    isVideoPost = true;
                    this.logger.info('Detected video post');

                    if (this.capturedVideoUrl) {
                        postVideoUrl = this.capturedVideoUrl;
                        this.logger.info(`Using captured video URL: ${this.capturedVideoUrl}`);
                    } else {
                        this.logger.warn('Video post detected but no video URL was captured from network requests');
                    }
                } else {
                    const imageLocators = [
                        this.page.locator('div[role="dialog"] img[src*="instagram"]').first(),
                        this.page.locator('div[role="dialog"] img[alt]').first(),
                        this.page.locator('div[role="dialog"] article img').first(),
                    ];

                    for (const imageLocator of imageLocators) {
                        if ((await imageLocator.count()) > 0 && (await imageLocator.isVisible({ timeout: 2000 }))) {
                            const src = await imageLocator.getAttribute('src');
                            if (src && !src.includes('static') && !src.includes('sprite')) {
                                postImageUrl = src;
                                this.logger.info(`Found post image: ${src.substring(0, 80)}...`);
                                break;
                            }
                        }
                    }

                    if (!postImageUrl) {
                        this.logger.info('No post image found or image could not be extracted.');
                    }
                }
            } catch (e) {
                this.logger.warn('Could not extract post media.');
            }

            this.logger.action('Generating AI comment...');
            const aiComment = await this.aiGenerator.generateInstagramComment(
                postCaption,
                targetUsername,
                aiPromptHint,
                postImageUrl,
                postVideoUrl
            );
            this.logger.success(`AI Generated Comment: "${aiComment}"`);

            const commentTextarea = this.page.locator(dialogSelector).locator('textarea[aria-label*="Add a comment"]');
            if ((await commentTextarea.count()) === 0) {
                this.logger.warn(`Comments might be disabled for this post. Cannot find comment area.`);
                await this.page.screenshot({
                    path: path.join(this.logsDir, `no_comment_area_error_${this.config.username}_${targetUsername}.png`),
                });
                return 'SKIPPED';
            }

            await this.humanBehavior.jitteryMovement(commentTextarea);
            await this.humanBehavior.randomDelay(1000, 3000);

            this.logger.action(`Typing comment...`);
            await this.humanBehavior.naturalTyping(commentTextarea, aiComment);
            await this.humanBehavior.randomDelay(1500, 4000);

            const postButton = this.page
                .locator(dialogSelector)
                .locator('form')
                .getByRole('button', { name: 'Post' });

            if ((await postButton.count()) === 0 || !(await postButton.isEnabled())) {
                this.logger.error(`Could not find an enabled "Post" button.`);
                await this.page.screenshot({
                    path: path.join(this.logsDir, `no_post_button_error_${this.config.username}_${targetUsername}.png`),
                });
                return 'FAILED';
            }

            this.logger.action(`Submitting the comment...`);
            await this.humanBehavior.hesitateAndClick(postButton);
            await this.humanBehavior.randomDelay(4000, 7000);

            const ourComment = this.page.locator(dialogSelector).getByText(aiComment);
            if ((await ourComment.count()) > 0) {
                this.logger.success(`Successfully commented on @${targetUsername}'s post.`);
                await this.logInteraction(targetUsername, 'comment', aiComment);
                return 'SUCCESS';
            } else {
                this.logger.warn(`Could not verify if comment was posted successfully.`);
                await this.logInteraction(targetUsername, 'comment', aiComment);
                return 'SUCCESS';
            }
        } catch (error: any) {
            this.logger.error(`An error occurred during comment task for @${targetUsername}: ${error.message}`);
            await this.page.screenshot({ path: path.join(this.logsDir, `comment_task_error_${this.config.username}_${targetUsername}.png`) });
            return 'FAILED';
        } finally {
            this.isCapturingVideo = false;
        }
    }
}
