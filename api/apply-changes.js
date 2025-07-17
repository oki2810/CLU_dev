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
  const APP_ORIGIN = process.env.APP_ORIGIN || 'https://ccfolialoguploader.com';

  function isOriginAllowed(origin, userOrigin) {
    if (typeof origin !== 'string') return false;
    const lcOrigin = origin.toLowerCase();
    const allowed =
      lcOrigin === APP_ORIGIN.toLowerCase() ||
      (lcOrigin.endsWith('.github.io') &&
        (lcOrigin === TEMPLATE_ORIGIN.toLowerCase() ||
          lcOrigin === userOrigin.toLowerCase()));
    console.log('[apply-changes] Origin check', { origin, userOrigin, allowed });
    return allowed;
  }

  // --- CORS ヘッダー設定 ---
  function setCorsHeaders(res, origin) {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    console.log('[apply-changes] CORS headers set for:', origin);
  }

  // --- OPTIONS（プリフライト） ---
  if (req.method === 'OPTIONS') {
    console.log('[apply-changes] Handling preflight OPTIONS');
    if (origin && origin.toLowerCase().endsWith('.github.io')) {
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
  if (origin) {
    setCorsHeaders(res, origin);
  } else {
    setCorsHeaders(res);
  }

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


  try {
    // 1) リポジトリ情報取得
    const {
      data: { default_branch: branch },
    } = await octokit.repos.get({ owner, repo });

    // 2) 最新コミットとベースツリー取得
    const {
      data: {
        object: { sha: latestCommitSha },
      },
    } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });

    const {
      data: { tree: { sha: baseTreeSha } },
    } = await octokit.git.getCommit({ owner, repo, commit_sha: latestCommitSha });

    // 3) index.html 取得
    const { data: indexFile } = await octokit.repos.getContent({
      owner,
      repo,
      path: "index.html",
      ref: branch,
    });
    const html = Buffer.from(indexFile.content, "base64").toString("utf-8");

    // 4) HTML 更新ロジック
    function updateIndexHtml(srcHtml, orderArr, deletesSet) {
      return srcHtml.replace(
        /(<ul\s+id="log-list"[^>]*>)([\s\S]*?)(<\/ul>)/,
        (_, openTag, inner, closeTag) => {
          const liRe = /<li[^>]*data-path="([^"]+)"[^>]*>[\s\S]*?<\/li>/g;
          const map = {};
          let m;
          while ((m = liRe.exec(inner))) {
            map[m[1]] = m[0];
          }
          const newList = orderArr
            .filter(p => !deletesSet.has(p))
            .map(p => map[p] || `<li data-path="${p}">${p}</li>`)
            .join("\n");
          return `${openTag}\n${newList}\n${closeTag}`;
        }
      );
    }
    const updatedHtml = updateIndexHtml(html, order, new Set(deletes));

    // 5) 新しい blob 作成
    const {
      data: { sha: newBlobSha },
    } = await octokit.git.createBlob({
      owner,
      repo,
      content: updatedHtml,
      encoding: "utf-8",
    });

    // 6) 新ツリー作成（index.html 更新 + ファイル削除）
    const treeItems = [
      { path: "index.html", mode: "100644", type: "blob", sha: newBlobSha },
      ...deletes.map(path => ({
        path,
        mode: "100644",
        type: "blob",
        sha: null,
      })),
    ];
    const {
      data: { sha: newTreeSha },
    } = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    // 7) コミット作成
    const {
      data: { sha: newCommitSha },
    } = await octokit.git.createCommit({
      owner,
      repo,
      message: "Apply log reorder and deletions",
      tree: newTreeSha,
      parents: [latestCommitSha],
    });

    // 8) ブランチ更新
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommitSha,
    });

    // 返却値にコミット SHA を含める
    return res.status(200).json({ ok: true, commit: newCommitSha });
  } catch (error) {
    console.error("apply-changes error:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
