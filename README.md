![Message Counter Pro Banner](https://db.nlcat.dpdns.org/banner-twitter-1500x500%20(7).png)

# Discord Message counter

這是一款專為大型 Discord 伺服器設計的高效能訊息計數機器人。它採用了先進的快取策略與非同步處理架構，能夠在不影響機器人回應速度的前提下，精確、即時地統計伺服器內所有成員的訊息數量，並提供互動式的排行榜功能。

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Discord.js](https://img.shields.io/badge/Discord.js-5865F2?style=for-the-badge&logo=discord&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)

## ✨ 核心功能

- **高效能訊息計數**: 採用 **Write-Behind Caching (後寫快取)** 模式，新訊息的計數會先寫入高速的 Redis 快取，再由背景任務定期、批量地寫入 PostgreSQL 資料庫，大幅降低了資料庫的寫入壓力，確保機器人即時回應。
- **即時排行榜**: 利用 Redis 的 Sorted Set 資料結構，排行榜數據能夠即時更新與查詢，提供使用者秒級更新的排名體驗。
- **智慧快取策略**:
  - **啟動預熱 (Cache Warming)**: 機器人啟動時，會自動從資料庫讀取權威數據，預先載入到 Redis 中，確保啟動後立即提供準確的排行榜。
  - **分頁快取 (Pagination Caching)**: 對排行榜的每一頁查詢結果進行快取，減少重複計算，提升翻頁速度。
  - **快取失效 (Cache Invalidation)**: 當有新訊息時，會自動清除相關的排行榜分頁快取，確保使用者下次查詢時能看到最新數據。
- **完整歷史訊息同步 (`/sync-full`)**:
  - 使用 **Worker Threads (工作線程)** 平行處理多個頻道，極大地提升了初次同步整個伺服器歷史訊息的速度，避免主線程被長時間阻塞。
  - 提供詳細的進度回報（進度條、預計剩餘時間、處理速度），並透過私訊發送給指令使用者，避免洗版。
- **增量訊息同步 (`/sync-missing`)**: 機器人下線後，可透過此指令快速掃描並補全遺漏的訊息，無需進行耗時的完整同步。
- **進階排行榜查詢**: 支援按特定頻道、特定日期 (`YYYY-MM-DD`) 篩選排行榜。
- **互動式介面**: 排行榜支援按鈕翻頁，並提供「跳至頁數」的彈出式視窗，提升使用者體驗。
- **高可靠性**:
  - 使用 **Redis Lock** 防止多個同步任務同時執行，確保資料一致性。
  - 資料庫操作採用交易 (Transaction)，確保批次寫入的原子性。

## 🏛️ 技術架構

本專案的數據流與核心架構如下：

```
                                  +-----------------------+
                                  |   Discord Message     |
                                  +-----------+-----------+
                                              |
                                              v
+-----------------------------------------------------------------------------------------+
|                                  Discord Bot (Node.js)                                  |
|                                                                                         |
|  +-------------------------+      +---------------------------+     +-------------------+
|  |   messageCreate Event   |----->|      Redis (Cache)        |<--->|   /leaderboard    |
|  +-------------------------+      |                           |     |      Command      |
|              |                    | 1. Dirty Hashes (增量)    |     +-------------------+
|              |                    | 2. Sorted Set (即時排名)  |               |
|              +------------------->| 3. Page Cache (分頁結果)  |---------------+
|                                   +---------------------------+               |
|                                              |                                |
|          (Every 30s)                         | (Batch Write)                  | (Cache Miss/Filtered)
|                v                             v                                v
|  +-----------------------------+    +-------------------------------------------------+
|  |   Write-Behind Job          |--->|             PostgreSQL (Database)               |
|  | (flushDirtyCountsToDB)      |    |            (The Source of Truth)                |
|  +-----------------------------+    +-------------------------------------------------+
|                                                                                         |
+-----------------------------------------------------------------------------------------+

 Worker Threads for /sync-full:
 [ Main Thread ] <--- (Aggregated Data) --- [ Worker 1: Channels A, B ]
                                          /
               <--- (Aggregated Data) --- [ Worker 2: Channels C, D ]
                                          /
               <--- (AggregatedData)  --- [ Worker n: ...         ]

```

1.  **訊息計數**:
    - 當使用者發送一則訊息，`messageCreate` 事件被觸發。
    - 機器人會對 Redis 執行兩個操作：
      1.  在一個 Hash 中 (`dirty_counts:{guild_id}`) 累加該使用者在該頻道的當日訊息數（此為 "髒" 數據）。
      2.  在一個 Sorted Set 中 (`leaderboard:{guild_id}`) 將該使用者的總分（總訊息數）加一，用於即時排行榜。
2.  **批次寫入資料庫**:
    - 一個定時任務 (`setInterval`) 每 30 秒會觸發 `flushDirtyCountsToDB` 函式。
    - 此函式會從 Redis 取出所有 "髒" 數據，並使用 PostgreSQL 高效率的 `UNNEST` 和 `ON CONFLICT ... DO UPDATE` 語法，一次性地將大量更新寫入資料庫。
3.  **排行榜查詢**:
    - 使用者執行 `/leaderboard` 指令。
    - **預設情況 (無篩選)**: 直接從 Redis 的 Sorted Set 中取得排名，速度極快。
    - **篩選情況 (指定頻道/日期)**: 直接查詢 PostgreSQL 資料庫以獲取最精確的結果。
    - 查詢結果會被快取在 Redis 中，以加速後續的相同查詢。

## ⚙️ 安裝與設定

### 1. 環境需求

- [Node.js](https://nodejs.org/) v24.x 或更高版本
- [PostgreSQL](https://www.postgresql.org/) v17.x 或更高版本
- [Redis](https://redis.io/) v6.x 或更高版本

### 2. 專案設定

1.  **複製專案**
    ```bash
    git clone https://github.com/956zs/discord-message-counter.git
    cd discord-message-counter
    ```

2.  **安裝依賴**
    ```bash
    npm install
    ```

3.  **設定環境變數**
    複製 `.env.example` 文件為 `.env`，並填入您的設定：
    ```env
    # Discord Bot
    DISCORD_TOKEN=你的機器人Token
    CLIENT_ID=你的機器人Client_ID

    # PostgreSQL Database
    DB_HOST=localhost
    DB_PORT=5432
    DB_USER=postgres
    DB_PASSWORD=你的資料庫密碼
    DB_DATABASE=discord_counter

    # Redis
    REDIS_HOST=localhost
    REDIS_PORT=6379
    REDIS_PASSWORD= # 如果你的Redis有密碼，請填寫
    REDIS_DB=2 # 建議為機器人使用一個獨立的DB
    ```

4.  **設定資料庫**
    連接到您的 PostgreSQL 資料庫，並執行以下 SQL 指令來建立必要的資料表：

    ```sql
    -- 儲存每日訊息計數的資料表
    CREATE TABLE message_counts (
        user_id BIGINT NOT NULL,
        guild_id BIGINT NOT NULL,
        channel_id BIGINT NOT NULL,
        message_date DATE NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, guild_id, channel_id, message_date)
    );

    -- 創建索引以優化查詢
    CREATE INDEX idx_message_counts_guild_user ON message_counts(guild_id, user_id);
    CREATE INDEX idx_message_counts_guild_date ON message_counts(guild_id, message_date);

    -- 儲存同步狀態的資料表
    CREATE TABLE sync_status (
        guild_id BIGINT PRIMARY KEY,
        full_sync_status VARCHAR(20) DEFAULT 'none', -- none, in_progress, completed, failed
        last_full_sync_updated TIMESTAMPTZ,
        last_known_message_id BIGINT
    );
    ```

5.  **編譯 TypeScript**
    ```bash
    npm run build
    ```
    這會將 `src` 目錄下的 TypeScript 檔案編譯成 JavaScript，並輸出到 `dist` 目錄。

## 🚀 執行專案

1.  **部署斜線指令 (只需執行一次)**
    在第一次啟動或修改了指令定義後，需要執行此指令將指令註冊到 Discord。
    ```bash
    npm run deploy
    ```

2.  **啟動機器人 (生產環境)**
    ```bash
    npm run start
    ```

3.  **啟動機器人 (開發環境)**
    使用 `nodemon` 和 `ts-node`，在程式碼變更時會自動重啟，方便開發。
    ```bash
    npm run dev
    ```

## 📋 可用指令

- `/leaderboard [channel] [date]`
  - 顯示伺服器訊息排行榜。
  - `channel` (可選): 只顯示特定頻道的排行榜。
  - `date` (可選): 只顯示特定日期的排行榜 (格式: `YYYY-MM-DD`)。

- `/sync-full` (僅限管理員)
  - **【高耗時/危險】** 刪除伺服器所有現有計數，並從頭開始同步所有頻道的歷史訊息。適用於首次設定或數據嚴重損毀時。

- `/sync-missing` (僅限管理員)
  - **【快速】** 掃描並補全機器人下線期間遺漏的訊息。建議在機器人重啟後執行。

