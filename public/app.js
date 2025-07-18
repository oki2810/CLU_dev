document.addEventListener("DOMContentLoaded", () => {
    // CSRF トークン取得
    function getCsrfToken() {
        const match = document.cookie.match(/(?:^| )XSRF-TOKEN=([^;]+)/);
        return match ? decodeURIComponent(match[1]) : "";
    }

    // --- 要素取得 ---
    const githubConnectBtn = document.getElementById("githubConnectBtn");
    const authSection = document.getElementById("authSection");
    const loginPanel = document.getElementById("loginPanel");
    const loginInfo = document.getElementById("loginInfo");
    const githubDisconnectBtn = document.getElementById("githubDisconnectBtn");
    const repoSettings = document.getElementById("repoSettings");
    const repoInput = document.getElementById("repoInput");
    const pathInput = document.getElementById("pathInput");
    const useExistingBtn = document.getElementById("useExistingBtn");
    const createAndInitBtn = document.getElementById("createAndInitBtn");
    const initStatus = document.getElementById("initStatus");

    const uploadHtml = document.getElementById("uploadHtml");
    const formatBtn = document.getElementById("formatBtn");
    const filenameInput = document.getElementById("filenameInput");
    const formattedOutput = document.getElementById("formattedOutput");
    const githubUploadBtn = document.getElementById("githubUploadBtn");
    const viewProjectBtn = document.getElementById("viewProjectBtn");
    const viewRepoBtn = document.getElementById("viewRepoBtn");
    const githubStatus = document.getElementById("githubStatus");

    // タブ切り替え要素
    const tabs = {
        tabCCU: "ccuContent",
        tabUsage: "usageContent",
        tabFeature: "featureContent"
    };

    let ownerName = "";

    // --- 最後に使用したリポジトリ保存用 Cookie ---
    function getLastRepo() {
        const m = document.cookie.match(/(?:^| )last_repo=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : "";
    }
    function setLastRepo(repo) {
        document.cookie = `last_repo=${encodeURIComponent(repo)}; max-age=${60 * 60 * 24 * 30}; path=/`;
    }

    // ページ読み込み時に前回のリポジトリを入力欄へ反映
    const savedRepo = getLastRepo();
    if (savedRepo && repoInput) {
        repoInput.value = savedRepo;
    }

    // シナリオ名 → path 同期
    if (filenameInput && pathInput) {
        const syncPath = () => {
            const name = filenameInput.value.trim() || "test";
            pathInput.value = `log/${name}.html`;
        };
        filenameInput.addEventListener("input", syncPath);
        syncPath();
    }

    // --- タブ切り替え ---
    Object.values(tabs).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = "none";
    });

    document.getElementById("ccuContent").style.display = "block";

    Object.entries(tabs).forEach(([tabId, contentId]) => {
        const tab = document.getElementById(tabId);
        const content = document.getElementById(contentId);
        if (!tab || !content) return;
        tab.addEventListener("click", () => {
            console.log("clicked:", tabId, "→ show:", contentId, content);
            Object.keys(tabs).forEach(id => {
                document.getElementById(id).classList.remove("active");
            });
            tab.classList.add("active");
            // コンテンツ表示切替
            Object.values(tabs).forEach(id => {
                document.getElementById(id).style.display = "none";
            });
            content.style.display = "block";
        });
    });

    // --- GitHub OAuth 開始・解除 ---
    githubConnectBtn.addEventListener("click", () => {
        window.location.href = "/api/auth/github";
    });
    githubDisconnectBtn.addEventListener("click", async () => {
        await fetch("/api/logout", {
            method: "POST",
            credentials: "include",
            headers: {
                "X-CSRF-Token": getCsrfToken()
            }
        });
        window.location.reload();
    });

    // 認証状態チェック
    fetch("/api/auth-status", {
        credentials: "include",
        headers: {
            "X-CSRF-Token": getCsrfToken()
        }
    })
        .then(res => res.json())
        .then(data => {
            if (data.authenticated) {
                authSection.style.display = "none";
                loginPanel.style.display = "flex"; // ← 表示
                repoSettings.style.display = "block";
                loginInfo.textContent = `GitHub連携中: ${data.username}`;
                ownerName = data.username;
            } else {
                authSection.style.display = "block";
                loginPanel.style.display = "none";
                repoSettings.style.display = "none";
                ownerName = "";
            }

            // 認証状態に関わらずボタン状態を更新
            updateViewBtn();
        });

    // リポジトリ名入力必須チェック
    function requireRepo() {
        if (!repoInput.value.trim()) {
            alert("リポジトリ名を入力してください");
            return false;
        }
        return true;
    }

    // プロジェクト公開リンク・リポジトリリンク更新
    function updateViewBtn() {
        if (!viewProjectBtn || !viewRepoBtn) return;
        const repo = repoInput.value.trim();
        if (ownerName && repo) {
            const pageUrl = `https://${ownerName}.github.io/${repo}/`;
            viewProjectBtn.onclick = () => window.open(pageUrl, "_blank");

            const repoUrl = `https://github.com/${ownerName}/${repo}`;
            viewRepoBtn.onclick = () => window.open(repoUrl, "_blank");
        } else {
            viewProjectBtn.onclick = () => alert("リポジトリ名を入力してください");
            viewRepoBtn.onclick = () => alert("リポジトリ名を入力してください");
        }
        viewProjectBtn.style.display = "inline-block";
        viewRepoBtn.style.display = "inline-block";
    }

    // GitHub Pages ビルド完了待ち
    async function waitForBuildCompletion(owner, repo, commit) {
        while (true) {
            try {
                const res = await fetch("/api/pages-status", {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "Content-Type": "application/json",
                        "X-CSRF-Token": getCsrfToken(),
                    },
                    body: JSON.stringify({ owner, repo, commit }),
                });
                const data = await res.json();
                if (data.ok && data.done) {
                    return;
                }
            } catch (err) {
                console.error("pages-status fetch error:", err);
            }
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
    repoInput.addEventListener("input", () => {
        updateViewBtn();
        const v = repoInput.value.trim();
        if (v) setLastRepo(v);
    });
    updateViewBtn();

    // --- 既存リポジトリ利用チェック ---
    useExistingBtn.addEventListener("click", async () => {
        const repo = repoInput.value.trim();
        if (!repo) return alert("リポジトリ名を入力してください");

        initStatus.textContent = "リポジトリを確認中…";

        try {
            const res = await fetch("/api/check-repo", {
                method: "POST",
                credentials: "include",
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRF-Token": getCsrfToken(),
                },
                body: JSON.stringify({
                    owner: ownerName,
                    repo
                }),
            });
            const result = await res.json();
            if (result.ok) {
                initStatus.innerHTML =
                    `<div class="alert alert-success">既存リポジトリを使用します。</div>`;
                updateViewBtn();
            } else {
                initStatus.innerHTML =
                    `<div class="alert alert-danger">エラー: ${result.error}</div>`;
            }
        } catch (err) {
            console.error(err);
            initStatus.innerHTML =
                `<div class="alert alert-danger">通信エラーが発生しました</div>`;
        }
    });

    // --- リポジトリ作成＆初期化 ---
    createAndInitBtn.addEventListener("click", async () => {
        const repo = repoInput.value.trim();
        if (!repo) return alert("リポジトリ名を入力してください");

        initStatus.textContent = "GitHubリポジトリを作成し、初期設定中…";

        try {
            const res = await fetch("/api/create-and-init", {
                method: "POST",
                credentials: "include",
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRF-Token": getCsrfToken(),
                },
                body: JSON.stringify({
                    repo
                }),
            });
            const result = await res.json();
            if (result.ok) {
                const pagesUrl =
                    `https://github.com/${ownerName}/${repo}/settings/pages`;
                initStatus.innerHTML =
                    `<div class="alert alert-success">リポジトリ作成が完了しました！<br>こちら<a href="${pagesUrl}" target="_blank" rel="noopener noreferrer">${pagesUrl}</a>からPage設定を行ってください！</div>`;
                updateViewBtn();
            } else {
                initStatus.innerHTML =
                    `<div class="alert alert-danger">エラー: ${result.error}</div>`;
            }
        } catch (err) {
            console.error(err);
            initStatus.innerHTML =
                `<div class="alert alert-danger">通信エラーが発生しました</div>`;
        }
    });

    // --- HTML 整形 ---
    formatBtn.addEventListener("click", () => {
        if (!requireRepo()) return;
        if (!uploadHtml.files.length)
            return alert("整形したい HTML ファイルを選択してください");
        const reader = new FileReader();
        reader.onload = (e) => {
            let html = e.target.result;
            const robotsMeta = '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex, nocache">';
            const fontStyle =
                '<style>* { font-family: sans-serif !important; }</style>';
            const norobotScript = '<script src="norobot.js"></scr' + 'ipt>';
            html = html.replace(/<\/head>/i, robotsMeta + "\n" + fontStyle + "\n" +
                norobotScript + "\n</head>");
            formattedOutput.textContent = html;
        };
        reader.readAsText(uploadHtml.files[0]);
    });

    // --- GitHub へのコミット ---
    githubUploadBtn.addEventListener("click", async () => {
        if (!requireRepo()) return;

        const repo = repoInput.value.trim();
        const path = pathInput.value.trim();
        const scenarioName = filenameInput.value.trim();
        const linkText = scenarioName;

        // hidden input に値をセット
        document.getElementById("ownerInput").value = ownerName;
        document.getElementById("linkTextInput").value = linkText;

        if (!formattedOutput.textContent) {
            return alert("まずは「修正」ボタンで整形してください");
        }
        if (!ownerName || !path) {
            return alert("リポジトリ情報をすべて入力してください");
        }

        githubStatus.textContent = "送信中…";

        try {
            // 1) FormData 組み立て
            const formData = new FormData();
            const fixedBlob = new Blob([formattedOutput.textContent], { type: "text/html" });
            formData.append("htmlFile", fixedBlob, "log.html");
            formData.append("owner", ownerName);
            formData.append("repo", repo);
            formData.append("path", path);
            formData.append("linkText", linkText);
            formData.append("scenarioName", scenarioName);

            // 2) サーバーへ送信（ここで１回だけ fetch）
            const resp = await fetch("/api/upload", {
                method: "POST",
                credentials: "include",
                headers: { "X-CSRF-Token": getCsrfToken() },
                body: formData,
            });

            // 3) レスポンス ボディを文字列でログ出力
            const raw = await resp.text();
            console.log("🔥 /api/upload 生レスポンス:", raw);

            // 4) JSON じゃなければエラー表示
            let result;
            try {
                result = JSON.parse(raw);
            } catch (e) {
                console.error("❌ レスポンスがJSONではありません:", e);
                githubStatus.innerHTML =
                    `<div class="alert alert-danger">サーバーエラー（非JSONレスポンス）</div>`;
                return;
            }

            // 5) HTTPステータスチェック
            if (!resp.ok) {
                githubStatus.innerHTML =
                    `<div class="alert alert-danger">エラー：${result.error || resp.statusText}</div>`;
                return;
            }

            // 6) 成功したのでページビルドを待つ
            githubStatus.textContent = "デプロイ中…(2~3分かかります)";
            await waitForBuildCompletion(ownerName, repo, result.commit);
            githubStatus.innerHTML =
                '<div class="alert alert-success">GitHubへのコミットに成功しました！</div>';
        } catch (err) {
            console.error("通信中にエラー:", err);
            githubStatus.innerHTML =
                `<div class="alert alert-danger">通信エラーが発生しました</div>`;
        }
    });
});
