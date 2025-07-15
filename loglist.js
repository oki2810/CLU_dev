// loglist.js
document.addEventListener("DOMContentLoaded", () => {
  const list = document.getElementById("log-list");
  const { owner, repo, apiBase } = window.CCU_CONFIG;
  console.log("CCU_CONFIG:", window.CCU_CONFIG);
  if (!list) return;

  // 1) Sortable.js でドラッグ＆ドロップ並べ替え
  new Sortable(list, {
    animation: 150,
    onEnd: async () => {
      // 並び順取得
      const order = Array.from(list.children)
        .map(li => li.dataset.path);
      try {
      await fetch(`${apiBase}/api/reorder-logs`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, order })
      });
      } catch (e) {
        console.error("並べ替えコミットに失敗:", e);
      }
    }
  });

  // 2) 削除ボタンのハンドラ
  list.addEventListener("click", async e => {
    const btn = e.target.closest(".btn-delete");
    if (!btn) return;
    const li  = btn.closest("li");
    const path = li.dataset.path;
    
    if (!confirm("このログを削除してもよいですか？")) return;

    try {
      const res = await fetch(`${apiBase}/api/delete-log`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, repo, path })
      });
      
      const result = await res.json();
      if (result.ok) {
        li.remove();
      } else {
        console.error("削除エラー：", result.error);
      }
    } catch (err) {
      console.error("削除リクエスト失敗：", err);
    }
  });
});
