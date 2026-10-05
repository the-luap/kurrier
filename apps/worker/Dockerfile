FROM node:24.20.0-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./

COPY packages ./packages
COPY apps/worker ./apps/worker

RUN pnpm install

WORKDIR /repo/apps/worker
ENV NITRO_PRESET=node-server
RUN pnpm run build

# Replace nitro's traced nodemailer copy with the full package (whatever
# version the lockfile resolves, so a nodemailer bump does not break this).
RUN for d in .output/server/node_modules/nodemailer .output/server/node_modules/.nitro/nodemailer@*; do \
      [ -d "$d" ] || continue; \
      rm -rf "$d" && cp -RL node_modules/nodemailer "$d"; \
    done

FROM node:24.20.0-alpine
WORKDIR /app

RUN apk add --no-cache postgresql-client bash
COPY db/init/db-bootstrap.sh /scripts/db-bootstrap.sh
COPY db/init/migrations /scripts/migrations
RUN chmod +x /scripts/db-bootstrap.sh

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001

COPY apps/worker/package.json ./package.json
COPY pnpm-lock.yaml ./pnpm-lock.yaml
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate && pnpm install --prod

COPY --from=build /repo/apps/worker/.output ./.output

EXPOSE 3001
CMD ["node", ".output/server/index.mjs"]
