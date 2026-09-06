FROM directus/directus:12.3.1

COPY --chown=node:node patch-csv-import.cjs /directus/patch-csv-import.cjs
RUN node /directus/patch-csv-import.cjs && rm /directus/patch-csv-import.cjs
