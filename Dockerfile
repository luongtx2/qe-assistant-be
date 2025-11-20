# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files để tận dụng Docker layer caching
COPY package*.json ./

# Cài đặt tất cả dependencies (bao gồm devDependencies để build)
RUN npm ci

# Copy source code và config
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Stage 2: Production
FROM node:20-slim AS production

WORKDIR /app

# Set environment variables
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

# Copy package files
COPY package*.json ./

# Cài đặt chỉ production dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built files từ builder stage
COPY --from=builder /app/dist ./dist

# Tạo non-root user để tăng bảo mật
RUN groupadd -r -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs nodejs && \
    chown -R nodejs:nodejs /app

# Chuyển sang non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check (đọc PORT từ environment variable)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1))"

# Start application
CMD ["node", "dist/index.js"]

