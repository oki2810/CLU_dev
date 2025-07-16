// pages/api/apply-changes.js
import { Octokit } from "@octokit/rest";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const { owner, repo, order, deletes } = req.body;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !Array.isArray(order) ||
    !Array.isArray(deletes)
  ) {
    return res.status(400).json({ ok: false, error: "Invalid request body" });
  }

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  try {
    // 1) リポジトリ情報取得 → デフォルトブランチ名の取得
    const {
      data: { default_branch: branch },
    } = await octokit.repos.get({ owner, repo });

    // 2) 先端コミットの取得
    const {
      data: {
        object: { sha: latestCommitSha },
      },
    } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });

    const {
      data: { tree: { sha: baseTreeSha } },
    } = await octokit.git.getCommit({ owner, repo, commit_sha: latestCommitSha });

    // 3) index.html を取得して並び替え・削除を反映した新しい内容を生成
    const { data: indexFile } = await octokit.repos.getContent({
      owner,
      repo,
      path: "index.html",
      ref: branch,
    });
    const html = Buffer.from(indexFile.content, "base64").toString("utf-8");

    const updatedHtml = updateIndexHtml(html, order, new Set(deletes));

    // 4) 新しい index.html を blob として作成
    const {
      data: { sha: newIndexBlobSha },
    } = await octokit.git.createBlob({
      owner,
      repo,
      content: updatedHtml,
      encoding: "utf-8",
    });

    // 5) 新しいツリーを作成（index.html 更新 + ファイル削除指示）
    const treeItems = [
      // index.html の更新
      {
        path: "index.html",
        mode: "100644",
        type: "blob",
        sha: newIndexBlobSha,
      },
      // 削除対象ファイルを一括で null sha に
      ...deletes.map((path) => ({
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

    // 6) コミットを作成
    const {
      data: { sha: newCommitSha },
    } = await octokit.git.createCommit({
      owner,
      repo,
      message: "Apply log reorder and deletions",
      tree: newTreeSha,
      parents: [latestCommitSha],
    });

    // 7) ブランチを最新コミットに更新
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommitSha,
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("apply-changes error:", error);
    return res
      .status(500)
      .json({ ok: false, error: error.message || "Internal error" });
  }
}

/**
 * index.html 中の <ul id="log-list">…</ul> 部分を
 * order の順に並び替え、deletes に該当する項目は除外して返します。
 */
function updateIndexHtml(html, order, deletesSet) {
  return html.replace(
    /(<ul\s+id="log-list"[^>]*>)([\s\S]*?)(<\/ul>)/,
    (all, openTag, innerHtml, closeTag) => {
      // <li> 要素を path→HTML でマッピング
      const liRe = /<li[^>]*data-path="([^"]+)"[^>]*>[\s\S]*?<\/li>/g;
      const map = {};
      let m;
      while ((m = liRe.exec(innerHtml))) {
        map[m[1]] = m[0];
      }
      // 新しい innerHTML を組み立て
      const newItems = order
        .filter((p) => !deletesSet.has(p))
        .map((p) => map[p] || `<li data-path="${p}">${p}</li>`)
        .join("\n");
      return `${openTag}\n${newItems}\n${closeTag}`;
    }
  );
}
