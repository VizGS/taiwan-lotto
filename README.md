# taiwan-lotto

台灣彩券開獎號碼查詢與號碼出現次數統計（今彩539、大樂透、威力彩、四星彩）。

純靜態網站，可直接部署在 GitHub Pages，**不需要任何後端伺服器或資料庫**。

## 運作方式

所有開獎資料由瀏覽器直接向台灣彩券官方 API 取得：

```
https://api.taiwanlottery.com/TLCAPIWeB/Lottery/{endpoint}
```

| 頁面 | 彩種 | endpoint | content key |
|------|------|----------|-------------|
| `lotto539.html` | 今彩539 | `Daily539Result` | `daily539Res` |
| `lottobig.html` | 大樂透 | `Lotto649Result` | `lotto649Res` |
| `lottosuper.html` | 威力彩 | `SuperLotto638Result` | `superLotto638Res` |
| `lotto4.html` | 四星彩 | `4DResult` | `lotto4DRes` |

`index.html` 會自動轉址到 `lotto539.html`。

### 查詢參數（query string）

- `max_results`：查詢筆數（預設 20，上限 500）。只有此參數改變才重新向 API 取資料。

## 檔案結構

```
index.html              轉址到 lotto539.html
lotto539.html / lottobig.html / lottosuper.html / lotto4.html
assets/app.js           核心：fetch + 逐月往前翻 + 統計 + 渲染
assets/styles.css       共用樣式
images/404.png          404 圖
404.html                GitHub Pages 404 頁
```

零建置（no build step）、零執行期依賴，純 vanilla JS。

## 部署（GitHub Pages）

1. Repo → Settings → Pages → Source 選 `main` branch（root）。
2. 站台會落在 `https://vizgs.github.io/taiwan-lotto/`。

> `404.html` 內的圖片與連結用 `/taiwan-lotto/` 開頭（Project Pages base path）。
> 若改用 User Pages（repo 名為 `vizgs.github.io`）或自訂網域，請把 `/taiwan-lotto/` 改成 `/`。

## 注意事項與已知限制

- **非官方 API 依賴**：`api.taiwanlottery.com/TLCAPIWeB/*` 是台彩官網的內部 API，無公開文件與版本承諾。回應格式、網址或 CORS 政策皆可能被官方單方變動。目前 API 回應 `access-control-allow-origin: *`，瀏覽器可跨域取用；**若官方收緊 CORS，純靜態版將無法繞過，需改用後端 proxy（如 Cloudflare Worker）**。
- 四星彩無號碼出現次數統計與直方圖。

## 開發 / 測試

純函式（號碼統計、逐月往前翻終止守衛等）有 Vitest 單元測試：

```
npm install
npm test
```

`node_modules` 不納入版控；網站本身不需要建置即可部署。
