// pages/api/pages-status.js
import { Octokit } from "@octokit/rest";

export const config = {
  api: { bodyParser: true },
  runtime: "nodejs",
};

// GitHub 認証済みユーザーを返す（失敗時は null）
async function getAuthenticatedUser(req) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split("; ").map((c) => c.split("="))
  );
  const token = cookies.access_token;
  if (!token) return null;
  try {
    const oct = new Octokit({ auth: token });
    const { data: me } = await oct.request("GET /user");
    return {
      octokit: oct,
      username: me.login,
      userOrigin: `https://${me.login}.github.io`,
    };
  } catch {
    return null;
  }
}

const APP_ORIGIN = process.env.APP_ORIGIN || "https://ccfolialoguploader.com";

// 既存の .github.io ドメインと APP_ORIGIN を許可
function isOriginAllowed(origin, userOrigin) {
  if (typeof origin !== "string") return false;
  if (origin === APP_ORIGIN) return true;
  return (
    origin.endsWith(".github.io") &&
    (origin === process.env.TEMPLATE_ORIGIN || origin === userOrigin)
  );
}

// どのレスポンスにも付与する CORS ヘッダー
function setCorsHeaders(res, origin) {
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  const origin = req.headers.origin;

  // 1) プリフライト対応
  if (req.method === "OPTIONS") {
    if (origin && origin.endsWith(".github.io")) {
      setCorsHeaders(res, origin);
      return res.status(204).end();
    }
    return res.status(403).end();
  }

  // 2) POST のみ許可
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).end();
  }

  // 共通: CORS ヘッダーをまず付与
  if (origin) {
    setCorsHeaders(res, origin);
  } else {
    setCorsHeaders(res);
  }

  // 3) 認証チェック
  const auth = await getAuthenticatedUser(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // 4) Origin チェック
  if (!isOriginAllowed(origin, auth.userOrigin)) {
    return res.status(403).json({ ok: false, error: "Origin not allowed" });
  }

  // 5) ボディ検証
  const { owner, repo, commit } = req.body;
  if (typeof owner !== "string" || typeof repo !== "string") {
    return res
      .status(400)
      .json({ ok: false, error: "owner and repo required" });
  }

  // 6) オーナー一致チェック
  if (owner !== auth.username) {
    return res.status(403).json({ ok: false, error: "Owner mismatch" });
  }

  // 7) ビルドステータス取得
  try {
    const { data } = await auth.octokit.rest.repos.getLatestPagesBuild({
      owner,
      repo,
    });
    const done = commit
      ? data.commit === commit && data.status === "built"
      : data.status === "built";
    return res
      .status(200)
      .json({ ok: true, status: data.status, commit: data.commit, done });
  } catch (err) {
    console.error("pages-status error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
