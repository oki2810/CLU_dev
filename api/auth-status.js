// pages/api/apply-changes.js

import { Octokit } from "@octokit/rest";

export const config = {
    api: { bodyParser: true },
    runtime: "nodejs",
};

export default async function handler(req, res) {
    const TEMPLATE_ORIGIN = process.env.TEMPLATE_ORIGIN || "https://oki2810.github.io";
    const origin = req.headers.origin;

    console.log('[apply-changes] Handler invoked', { method: req.method, origin });

    // --- 共通認証処理 ---
    async function getAuthenticatedUser() {
        console.log('[apply-changes] Authenticating user');
        const cookies = Object.fromEntries(
            (req.headers.cookie || "").split('; ').map(c => c.split('='))
        );
        const token = cookies.access_token;
        if (!token) {
            console.log('[apply-changes] No access_token cookie found');
            return null;
        }
        try {
            const oct = new Octokit({ auth: token });
            const { data: me } = await oct.request('GET /user');
            console.log('[apply-changes] Authenticated user:', me.login);
            const userOrigin = `https://${me.login}.github.io`;
            return { octokit: oct, username: me.login, userOrigin };
        } catch (error) {
            console.log('[apply-changes] Authentication error:', error);
            return null;
        }
    }

    // --- Origin 許可チェック ---
    function isOriginAllowed(origin, userOrigin) {
        const allowed = !!origin && origin.endsWith('.github.io') &&
            (origin === TEMPLATE_ORIGIN || origin === userOrigin);
        console.log('[apply-changes] Origin check', { origin, userOrigin, allowed });
        return allowed;
    }

    // --- CORS ヘッダー設定 ---
    function setCorsHeaders(res, origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        console.log('[apply-changes] CORS headers set for:', origin);
    }

    // --- OPTIONS（プリフライト） ---
    if (req.method === 'OPTIONS') {
        console.log('[apply-changes] Handling preflight OPTIONS');
        if (origin && origin.endsWith('.github.io')) {
            setCorsHeaders(res, origin);
            return res.status(204).end();
        }
        console.log('[apply-changes] Preflight origin not allowed:', origin);
        return res.status(403).end();
    }

    // --- POST のみ ---
    if (req.method !== 'POST') {
        console.log('[apply-changes] Method not allowed:', req.method);
        res.setHeader('Allow', 'POST, OPTIONS');
        return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    // 認証チェック
    const auth = await getAuthenticatedUser();
    if (!auth) {
        console.log('[apply-changes] Unauthorized: authentication failed');
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const { octokit, userOrigin, username } = auth;

    // Origin チェック
    if (!isOriginAllowed(origin, userOrigin)) {
        console.log('[apply-changes] Forbidden: origin not allowed');
        return res.status(403).json({ ok: false, error: 'Origin not allowed' });
    }
    setCorsHeaders(res, origin);

    // リクエストボディ検証
    const { owner, repo, order, deletes } = req.body;
    if (
        typeof owner !== 'string' ||
        typeof repo !== 'string' ||
        !Array.isArray(order) ||
        !Array.isArray(deletes)
    ) {
        console.log('[apply-changes] Bad Request: invalid body', req.body);
        return res.status(400).json({ ok: false, error: 'Invalid request body' });
    }

    // オーナー一致チェック
    if (owner !== username) {
        console.log('[apply-changes] Forbidden: owner mismatch', { owner, username });
        return res.status(403).json({ ok: false, error: 'Owner mismatch' });
    }

    export default async function handler(req, res) {
        const cookies = Object.fromEntries(
            (req.headers.cookie || "").split("; ").map(c => c.split("="))
        );
        const token = cookies.access_token;
        if (!token) return res.json({ authenticated: false });

        try {
            const octokit = new Octokit({ auth: token });
            const { data } = await octokit.rest.users.getAuthenticated();
            return res.json({ authenticated: true, username: data.login });
        } catch (err) {
            console.error("Failed to fetch user info", err);
            return res.json({ authenticated: true, username: null });
        }
    }
};
