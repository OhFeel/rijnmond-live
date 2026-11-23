FROM node:24-slim

# tzdata: timetable times are local (Europe/Amsterdam); see dayStart() in lib.js
RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates \
  && rm -rf /var/lib/apt/lists/* && mkdir /data && chown node:node /data

ENV TZ=Europe/Amsterdam NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY lib.js server.js ./
COPY public ./public

USER node
VOLUME /data
EXPOSE 3000
# first start downloads + processes the timetable (a few minutes), hence the long start period
HEALTHCHECK --interval=60s --timeout=5s --start-period=600s \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
