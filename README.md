# 🧩 Chrome Extension Chat Backend

## 🎯 Mục tiêu

Xây dựng backend cho **Chrome Extension nội bộ công ty**
– có **đăng nhập Microsoft (Entra ID)**
– chat với AI (Azure OpenAI hoặc LLM nội bộ)
– lưu lịch sử hội thoại, hành động và job vào **Azure Cosmos DB (Mongo API)**.
Triển khai chạy trên **Azure App Service Free tier**.

---

## ⚙️ Kiến trúc tổng quát

```
Extension (Popup / Content)
    ↓  (JWT Microsoft)
    ↓  REST + SSE
Azure App Service (Fastify + TypeScript)
    ↳ Cosmos DB (Mongo API)
    ↳ Azure OpenAI / nội bộ LLM
```

---

## 🧃 Database (Cosmos Mongo API)

### Database

`corp_extension`

### Collections

| Collection        | Mục đích                                        | Gợi ý field chính                                                        |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| **users**         | người dùng đăng nhập                            | `_id`, `email`, `displayName`, `roles`, `lastLogin`                      |
| **conversations** | phiên chat                                      | `_id`, `userId`, `title`, `status`, `lastMsgAt`, `createdAt`             |
| **messages**      | nội dung chat                                   | `_id`, `convId`, `userId`, `sender`, `content[]`, `createdAt`            |
| **actions**       | thao tác người dùng (push code, trigger job, …) | `_id`, `userId`, `type`, `payload`, `status`, `createdAt`                |
| **jobs**          | job async                                       | `_id`, `actionId`, `state`, `result`, `error`, `startedAt`, `finishedAt` |

---

## 🧱 Stack

* **Runtime:** Node.js 20
* **Framework:** Fastify
* **Language:** TypeScript
* **Database:** Cosmos DB (Mongo API)
* **Validation:** `zod`
* **Logging:** `pino`
* **Auth:** JWT Microsoft (verify qua Entra ID public keys)
* **Streaming:** SSE (Server-Sent Events)

---

## 📂 Cấu trúc thư mục

```
src/
├─ index.ts                 # entrypoint
├─ app.ts                   # init Fastify, plugin, routes
├─ db/mongo.ts              # connect Cosmos Mongo API
├─ routes/
│   ├─ chat.route.ts        # /api/conversations, /api/messages, /api/stream
│   ├─ actions.route.ts     # /api/actions, /api/jobs
│   └─ auth.middleware.ts   # verify Microsoft JWT
├─ services/
│   ├─ chat.service.ts
│   ├─ actions.service.ts
│   └─ jobs.service.ts
└─ schemas/
    ├─ chat.schema.ts
    ├─ actions.schema.ts
    └─ job.schema.ts
```

---

## 🔐 `.env` ví dụ

```bash
PORT=3000
COSMOS_URI=mongodb+srv://<user>:<pass>@<cosmos-endpoint>/
COSMOS_DB=corp_extension
# Azure OpenAI
AZURE_OPENAI_ENDPOINT=https://<your-endpoint>.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=gpt-4.1-mini
AZURE_OPENAI_MODEL=gpt-4.1-mini
AZURE_OPENAI_API_KEY=<your-api-key>
AZURE_OPENAI_API_VERSION=2024-04-01-preview
```

---

## 🚀 Endpoint tối thiểu

### Chat

| Method | Endpoint               | Mô tả                                 |
| ------ | ---------------------- | ------------------------------------- |
| `POST` | `/api/conversations`   | tạo hội thoại mới                     |
| `GET`  | `/api/conversations`   | list hội thoại theo user              |
| `POST` | `/api/messages`        | gửi tin nhắn, gọi Azure OpenAI (non-stream) |
| `GET`  | `/api/messages`        | list tin nhắn theo conversation       |
| `GET`  | `/api/stream?convId=…` | stream phản hồi AI (SSE) – TODO       |

### Actions / Jobs

| Method | Endpoint        | Mô tả                                     |
| ------ | --------------- | ----------------------------------------- |
| `POST` | `/api/actions`  | ghi hành động (push code, trigger job, …) |
| `GET`  | `/api/jobs/:id` | xem trạng thái job                        |

---

## 🔄 Luồng chat cơ bản

1. Extension gửi `POST /api/messages` (kèm JWT Microsoft - TODO auth).
2. Backend lưu message, lấy 5 turn gần nhất (10 messages) và gọi Azure OpenAI.
3. Lưu message trả lời vào Cosmos DB.
4. Cập nhật `conversations.lastMsgAt`.
5. (TODO) Trả về bằng **SSE** khi bật stream.

---

## 🧠 Bắt đầu cài đặt

### Cài thư viện

```bash
npm i fastify fastify-sse-v2 mongodb zod pino dotenv @fastify/swagger @fastify/swagger-ui @fastify/cors openai @azure/identity
npm i -D typescript ts-node-dev @types/node tsx
```

### Chạy local

```bash
npm run dev
```

Truy cập: [http://localhost:3000/health](http://localhost:3000/health)

---

## 🧩 Cấu hình Azure

| Dịch vụ                   | Mục đích         | Gợi ý setup               |
| ------------------------- | ---------------- | ------------------------- |
| **App Service**           | Deploy backend   | Plan F1 Free              |
| **Cosmos DB (Mongo API)** | Lưu data         | Free tier 1000 RU/s, 25GB |
| **Blob Storage (tuỳ)**    | Upload file chat | 5GB free                  |
| **Key Vault (tuỳ)**       | Lưu secret       | 10k ops free              |
| **Application Insights**  | Log              | Free quota                |

---

## 💬 Thiết kế chat

* (Hiện tại) Gọi Azure OpenAI non-stream, lưu reply vào DB.
* Lấy 5 turn gần nhất (tối đa ~10 messages) làm ngữ cảnh.
* (TODO) Nâng cấp lên SSE streaming.

---

## ✅ TODO (ghi chú triển khai tiếp)

- [ ] RAG cho hội thoại (retrieve context theo domain nội bộ)
- [ ] Conversation summary (tóm tắt context để rút ngắn history)
- [ ] Bật SSE streaming `/api/stream` (token-by-token)
- [ ] Auth Microsoft Entra ID (verify JWT)
- [ ] Rate limit theo userId
- [ ] Retry/backoff khi Azure OpenAI lỗi

---

## 🌐 Triển khai Azure

1. `az webapp up -n corp-extension-api -g <resourceGroup> --runtime "NODE:20LTS"`
2. Cấu hình biến môi trường trong App Service (`Settings > Configuration`).
3. Kết nối Cosmos bằng URI Mongo API.
4. Bật App Insights nếu cần log.
