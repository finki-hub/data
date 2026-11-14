# The FINKI Hub Directus image: the official Directus image with the
# CSV-import patch and this repository's extensions built in.

FROM --platform=${BUILDPLATFORM} node:24-alpine AS extensions
WORKDIR /build

COPY directus/extensions/directus-extension-data-operations/package.json directus/extensions/directus-extension-data-operations/package-lock.json ./data-operations/
COPY directus/extensions/directus-extension-course-search/package.json directus/extensions/directus-extension-course-search/package-lock.json ./course-search/
RUN npm ci --ignore-scripts --prefix data-operations && npm ci --ignore-scripts --prefix course-search

COPY directus/extensions/directus-extension-data-operations/src ./data-operations/src
COPY directus/extensions/directus-extension-course-search/src ./course-search/src
RUN npm run build --prefix data-operations && npm run build --prefix course-search

FROM directus/directus:latest

COPY --chown=node:node directus/patch-csv-import.cjs /directus/patch-csv-import.cjs
RUN node /directus/patch-csv-import.cjs && rm /directus/patch-csv-import.cjs

COPY --from=extensions --chown=node:node /build/data-operations/package.json /directus/extensions/directus-extension-data-operations/package.json
COPY --from=extensions --chown=node:node /build/data-operations/dist /directus/extensions/directus-extension-data-operations/dist
COPY --from=extensions --chown=node:node /build/course-search/package.json /directus/extensions/directus-extension-course-search/package.json
COPY --from=extensions --chown=node:node /build/course-search/dist /directus/extensions/directus-extension-course-search/dist

ARG APP_REVISION
ENV APP_REVISION=${APP_REVISION}

# The base image's own unprivileged user, stated explicitly.
USER node
