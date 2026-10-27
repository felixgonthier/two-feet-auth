# The Piggyback service. No dependencies to install: Node runs it as is.
#   docker build -t piggyback .
#   docker run -p 8787:8787 -v piggyback-data:/data -e PUBLIC_URL=https://feet.example.com -e PIGGYBACK_DATA_KEY=… piggyback
FROM node:22-alpine
LABEL org.opencontainers.image.title="Piggyback" \
      org.opencontainers.image.description="The new 2FA (Two-Feet Authentication): a foot-scan second factor with a hosted page, a drop-in element and an OpenID Connect provider." \
      org.opencontainers.image.source="https://github.com/felixgonthier/two-feet-auth" \
      org.opencontainers.image.licenses="NOASSERTION"
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY core ./core
COPY sdk ./sdk
COPY ui ./ui
COPY brand ./brand
COPY examples ./examples
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
# su-exec lets the entrypoint drop from root to the node user once /data is writable.
RUN apk add --no-cache su-exec && mkdir -p /data && chown node:node /data
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY deploy/piggyback-admin.sh /usr/local/bin/piggyback
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
