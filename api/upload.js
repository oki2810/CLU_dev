// pages/api/upload.js

import fs from "fs";
import path from "path";
// IncomingForm を直接インポート
import { IncomingForm } from "formidable";
import { Octokit } from "@octokit/rest";

export const config = {
  api: { bodyParser: false },
  runtime: 'nodejs',
};

const DEFAULT_INDEX = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>アップロード済みログ</title>
  <link
    href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"
    rel="stylesheet"
  />
</head>
<body>
  <div class="container py-5">
    <h1 class="mb-4">アップロード済みログ</h1>
    <ul id="log-list" class="list-group"></ul>
  </div>
  <script src="norobot.js"></script>
</body>
</html>`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    // --- 認証トークン取得 ---
    const cookies = Object.fromEntries(
      (req.headers.cookie || "")
        .split("; ")
        .map((c) => c.split("="))
    );
    const token = cookies.access_token;
    if (!token) {
      return res
        .status(401)
        .json({ ok: false, error: "Unauthorized" });
    }

    // --- multipart/form-data を formidable でパース ---
    const form = new IncomingForm({
      maxFileSize: 2 * 1024 * 1024,
    });
    const { fields, files } = await new Promise((ful, rej) => {
      form.parse(req, (err, fields, files) => {
        if (err) return rej(err);
        ful({ fields, files });
      });
    });

    // 必須フィールドチェック
    const { owner, repo, path: filePath, linkText, scenarioName } =
      fields;
    if (!owner || !repo || !filePath || !linkText || !scenarioName) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing parameters" });
    }

    // ファイルの一時パスを取得 (formidable v2: filepath, v1: path)
    const htmlFile = files.htmlFile;
    const tempPath = htmlFile?.filepath || htmlFile?.path;
    if (!htmlFile || typeof tempPath !== "string") {
      return res
        .status(400)
        .json({ ok: false, error: "No file uploaded" });
    }

    const octokit = new Octokit({ auth: token });

    // 1) アップロードされたログファイルを blob 化
    const buffer = fs.readFileSync(tempPath);
    const fileB64 = buffer.toString("base64");
    const { data: logBlob } = await octokit.git.createBlob({
      owner,
      repo,
      content: fileB64,
      encoding: "base64",
    });

    // 2) index.html を取得。なければ DEFAULT_INDEX を使う
    let html, indexSha;
    try {
      const idx = await octokit.repos.getContent({
        owner,
        repo,
        path: "index.html",
      });
      indexSha = idx.data.sha;
      html = Buffer.from(idx.data.content, "base64").toString("utf8");
      if (!html.trim()) html = DEFAULT_INDEX;
    } catch (err) {
      if (err.status === 404) {
        html = DEFAULT_INDEX;
        indexSha = null;
      } else {
        throw err;
      }
    }

    // 3) クライアント設定＆loglist.js 読み込みを挿入
    const configScript = `<script>
window.CCU_CONFIG = { owner: '${owner}', repo: '${repo}' };
</script>`;
    const loaderScript = `<script src="loglist.js"></script>`;
    html = html.replace(
      /(<script\s+src=["']norobot\.js["']><\/script>)/,
      `${configScript}\n${loaderScript}\n$1`
    );

    // 4) 新規 <li> ブロックを組み立て
    const timestamp = new Date().toISOString();
    const newItem = `
<li class="list-group-item d-flex justify-content-between align-items-center"
    data-date="${timestamp}"
    data-path="${filePath}"
>
  <span>
    <span class="text-muted">${scenarioName}</span>
    <a href="${filePath}" class="ms-2">${linkText}</a>
  </span>
  <button type="button" class="btn btn-sm btn-danger btn-delete">削除</button>
</li>
`.trim();

    // 5) <ul id="log-list"> の中に差し込む
    if (html.match(/<ul[^>]+id=["']log-list["'][^>]*>/)) {
      html = html.replace(
        /(<ul[^>]+id=["']log-list["'][^>]*>)/,
        `$1\n${newItem}`
      );
    } else {
      html = html.replace(
        /<\/body>/i,
        `<ul id="log-list" class="list-group">\n${newItem}\n</ul>\n</body>`
      );
    }

    // 6) 更新後の index.html を blob 化
    const { data: idxBlob } = await octokit.git.createBlob({
      owner,
      repo,
      content: Buffer.from(html, "utf8").toString("base64"),
      encoding: "base64",
    });

    // 7) 単一コミットでまとめてプッシュ (tree→commit→ref update)
    const { data: repoInfo } = await octokit.repos.get({ owner, repo });
    const branch = repoInfo.default_branch;
    const {
      data: refData,
    } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const baseCommitSha = refData.object.sha;
    const { data: baseCommit } = await octokit.git.getCommit({
      owner,
      repo,
      commit_sha: baseCommitSha,
    });

    // tree アイテム配列
    const treeItems = [
      { path: filePath, mode: "100644", type: "blob", sha: logBlob.sha },
      { path: "index.html", mode: "100644", type: "blob", sha: idxBlob.sha },
    ];

    // norobot.js / loglist.js を必要に応じて追加
    for (const asset of ["norobot.js", "loglist.js"]) {
      try {
        await octokit.repos.getContent({ owner, repo, path: asset });
      } catch (e: any) {
        if (e.status === 404) {
          const blob = fs.readFileSync(path.join(process.cwd(), "public", asset));
          const { data } = await octokit.git.createBlob({
            owner,
            repo,
            content: blob.toString("base64"),
            encoding: "base64",
          });
          treeItems.push({
            path: asset,
            mode: "100644",
            type: "blob",
            sha: data.sha,
          });
        }
      }
    }

    // tree→commit→ref update
    const { data: newTree } = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.tree.sha,
      tree: treeItems,
    });
    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo,
      message: `Upload ${filePath}`,
      tree: newTree.sha,
      parents: [baseCommitSha],
    });
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });

    // 成功レスポンス
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("Upload API error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err.message || "Unknown error" });
  }
}
