// pages/api/pages-status.js
import { Octokit } from "@octokit/rest";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }
  // Cookie から access_token を取り出して認証
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split("; ").map(c => c.split("="))
  );
  const token = cookies.access_token;
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const { owner, repo } = req.body || {};
  if (!owner || !repo) {
    return res.status(400).json({ ok: false, error: "Missing owner or repo" });
  }

  try {
    const oct = new Octokit({ auth: token });
    // 最新の Pages ビルドを取得
    const { data: build } = await oct.rest.repos.getLatestPagesBuild({
      owner,
      repo,
    });
    return res.json({ ok: true, status: build.status });
  } catch (error) {
    console.error("pages-status error:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
