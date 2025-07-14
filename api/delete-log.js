// pages/api/delete-log.js
import { Octokit } from "@octokit/rest";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split("; ").map(c => c.split("="))
  );
  const token = cookies.access_token;
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const { owner, repo, path } = req.body;
  if (!owner || !repo || !path)
    return res.status(400).json({ ok: false, error: "Missing parameters" });

  const octokit = new Octokit({ auth: token });
  try {
    // 1) 該当ログファイルを削除
    const fileResp = await octokit.repos.getContent({ owner, repo, path });
    await octokit.repos.deleteFile({
      owner,
      repo,
      path,
      sha: fileResp.data.sha,
      message: `Delete ${path}`
    });

    // 2) index.html から該当 <li> を取り除いて再コミット
    const idx = await octokit.repos.getContent({ owner, repo, path: "index.html" });
    const sha = idx.data.sha;
    let html = Buffer.from(idx.data.content, "base64").toString("utf8");
    // data-path 属性でマッチさせてブロックごと削除
    const re = new RegExp(`<li[\\s\\S]*?data-path="${path}"[\\s\\S]*?<\\/li>\\n?`, "g");
    html = html.replace(re, "");

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: "index.html",
      message: `Remove ${path} from index`,
      content: Buffer.from(html, "utf8").toString("base64"),
      sha
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("delete-log error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
