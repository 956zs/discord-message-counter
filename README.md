# 訊息計數機器人 Pro (Message Counter Pro)

 <!-- 建議可以自己做一個酷炫的橫幅圖片 -->

**一個為 Discord 伺服器打造的高可靠性、高效率的訊息統計機器人。採用 TypeScript 與 PostgreSQL，專為中小型社群設計，具備斷點續傳的歷史訊息同步能力。**

[![Discord.js](https://img.shields.io/badge/Discord.js-v14-7289DA?style=for-the-badge&logo=discord&logoColor=white)](https://discord.js.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)

---

## 🌟 核心亮點 (Core Features)

這個機器人不僅僅是個計數器，它的設計理念是**穩健**與**高效**。

-   **⚡ 即時統計**: 透過事件監聽，即時、準確地捕捉每一條新訊息。
-   **🛡️ 斷點續傳同步**: 獨特的歷史訊息同步機制，即使在同步數十萬條訊息的過程中意外中斷，下次也能從上次完成的頻道繼續，無需從頭再來。
-   **📊 精美排行榜**: 使用 Discord Embeds 生成視覺化的訊息排行榜，一目了然。
-   **⚙️ 狀態追蹤**: 為每個伺服器的同步任務維護狀態，防止重複執行，保證資料一致性。
-   **💪 專業架構**: 採用 TypeScript 進行強型別開發，搭配 PostgreSQL 進行高效能資料儲存，程式碼結構清晰、易於擴展。

### 🤖 功能展示 (Features in Action)

| 指令 (Command) | 描述 (Description) | 預覽 (Preview) |
| :--------------- | :------------------- | :--------------- |
| `/leaderboard` | 顯示伺服器中最活躍的成員排行榜。 |  <!-- 建議錄製一個 GIF 展示 --> |
| `/sync-messages` | **(僅限管理員)** 清理並重新同步伺服器所有歷史訊息。具備高容錯性，即使中斷也能恢復。 |  <!-- 建議錄製一個 GIF 展示 --> |
| `/my-stats` | (可擴充) 查詢你自己的訊息數量。 | N/A |

---

## 🏛️ 技術架構 (Architecture)

本專案的設計核心是**模組化**與**資料庫驅動的狀態管理**。

### 資料庫結構

我們使用兩張表來精確地管理數據與狀態：

1.  **`message_counts`**:
    -   以 `(user_id, guild_id, channel_id)` 為複合主鍵。
    -   精細地記錄每個使用者在**每個頻道**的訊息數量。
    -   為排行榜的匯總查詢和頻道級的同步操作提供了基礎。

2.  **`sync_status`**:
    -   以 `guild_id` 為主鍵。
    -   追蹤 `/sync-messages` 指令的執行狀態 (`in_progress`, `completed`, `failed`)。
    -   **`last_synced_channel_id`** 是實現斷點續傳的關鍵欄位。

### 容錯同步流程 (`/sync-messages`)

 <!-- 建議畫一個流程圖 -->

1.  **鎖定狀態**: 指令開始時，鎖定 `sync_status` 表，防止重複執行。
2.  **讀取進度**: 檢查 `last_synced_channel_id`，確定從哪個頻道開始。
3.  **頻道級冪等操作**:
    -   **開始同步一個頻道前**: `DELETE` 該頻道在 `message_counts` 中的所有記錄。
    -   **成功同步一個頻道後**: `UPDATE` `sync_status` 表，保存當前進度。
4.  **釋放狀態**: 任務全部完成或失敗後，更新最終狀態並釋放鎖。

---

## 🚀 開始使用 (Getting Started)

請按照以下步驟來設定和啟動你自己的機器人實例。

### 1. 先決條件 (Prerequisites)

-   [Node.js](https://nodejs.org/) (建議 v18 或更高版本)
-   [PostgreSQL](https://www.postgresql.org/download/) 資料庫伺服器
-   一個 Discord 機器人帳號 (可從 [Discord Developer Portal](https://discord.com/developers/applications) 建立)

### 2. 安裝 (Installation)

1.  **複製專案**
    ```bash
    git clone https://github.com/956zs/discord-message-counter.git
    cd your-repo-name
    ```

2.  **安裝依賴**
    ```bash
    npm install
    ```

3.  **設定環境變數**
    -   複製 `.env.example` (如果有的話) 或手動建立一個 `.env` 檔案。
    -   填入以下資訊：

    ```env
    # .env

    # Discord 機器人設定
    DISCORD_TOKEN=你的機器人TOKEN
    CLIENT_ID=你的機器人CLIENT_ID

    # PostgreSQL 資料庫連線設定
    DB_HOST=localhost
    DB_PORT=5432
    DB_USER=postgres
    DB_PASSWORD=你的資料庫密碼
    DB_DATABASE=discord_message_counter
    ```

### 3. 資料庫設定 (Database Setup)

連接到你的 PostgreSQL 伺服器 (例如使用 `psql` 或 DBeaver)，並執行以下 SQL 來建立必要的資料庫和資料表：

1.  **建立資料庫**
    ```sql
    CREATE DATABASE discord_message_counter;
    ```

2.  **連接到新資料庫並建立資料表**
    ```sql
    \c discord_message_counter

    -- 建立訊息計數表
    CREATE TABLE message_counts (
        user_id VARCHAR(255) NOT NULL,
        guild_id VARCHAR(255) NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        count BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, guild_id, channel_id)
    );

    -- 建立同步狀態追蹤表
    CREATE TABLE sync_status (
        guild_id VARCHAR(255) PRIMARY KEY,
        status VARCHAR(50) NOT NULL DEFAULT 'idle',
        last_synced_channel_id VARCHAR(255) NULL,
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ```

### 4. 啟動機器人 (Running the Bot)

專案提供了方便的 npm 腳本：

1.  **部署斜線指令 (只需執行一次)**
    -   在將機器人加入伺服器後，執行此指令來註冊所有斜線指令。
    ```bash
    npm run deploy
    ```

2.  **啟動機器人 (開發模式)**
    -   此模式下，檔案變更時會自動重啟，方便開發。
    ```bash
    npm run dev
    ```

3.  **啟動機器人 (正式環境)**
    -   此模式會先將 TypeScript 編譯成 JavaScript，然後再執行。
    ```bash
    npm run start
    ```

---

## 🤝 貢獻 (Contributing)

歡迎提交 Pull Requests 或 Issues！如果你有任何改進建議或發現了 Bug，請不要猶豫，讓我們一起讓這個專案變得更好。

## 📄 授權 (License)

本專案採用 [MIT License](LICENSE) 授權。