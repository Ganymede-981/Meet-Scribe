FROM node:20-alpine AS builder

WORKDIR /app

# Declare build-time args so Vite can bake them into the JS bundle
ARG VITE_BACKEND_URL
ARG VITE_FB_API_KEY
ARG VITE_FB_AUTH_DOMAIN
ARG VITE_FB_PROJECT_ID
ARG VITE_FB_STORAGE_BUCKET
ARG VITE_FB_MESSAGING_SENDER_ID
ARG VITE_FB_APP_ID

# Make them available as env vars during `npm run build`
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_FB_API_KEY=$VITE_FB_API_KEY
ENV VITE_FB_AUTH_DOMAIN=$VITE_FB_AUTH_DOMAIN
ENV VITE_FB_PROJECT_ID=$VITE_FB_PROJECT_ID
ENV VITE_FB_STORAGE_BUCKET=$VITE_FB_STORAGE_BUCKET
ENV VITE_FB_MESSAGING_SENDER_ID=$VITE_FB_MESSAGING_SENDER_ID
ENV VITE_FB_APP_ID=$VITE_FB_APP_ID

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Production image: serve with nginx ──────────────────────────
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html

# Replace default nginx config to handle React SPA routing
RUN printf 'server {\n\
    listen 80;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
\n\
    # Serve static assets with long cache\n\
    location ~* \.(js|css|woff2?|png|jpg|svg|ico)$ {\n\
        expires 1y;\n\
        add_header Cache-Control "public, immutable";\n\
    }\n\
\n\
    # All other routes fall back to index.html (SPA)\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
