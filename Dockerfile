FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
# Keep install and generation in one layer to avoid duplicating generated engines.
RUN npm ci && npm run build && npm cache clean --force
FROM build AS runtime
ENV NODE_ENV=production
USER node
EXPOSE 3000 4000
CMD ["npm", "run", "start:web"]
