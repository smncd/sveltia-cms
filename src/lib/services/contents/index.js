import { stripSlashes } from '@sveltia/utils/string';
import { get, writable } from 'svelte/store';
import { allAssetFolders, getMediaFieldURL } from '$lib/services/assets';
import { siteConfig } from '$lib/services/config';
import { getFieldConfig, getPropertyValue } from '$lib/services/contents/entry';
import { getFileConfig } from '$lib/services/contents/file';
import { getI18nConfig } from '$lib/services/contents/i18n';

/**
 * Regular expression to match `![alt](src "title")`.
 */
const markdownImageRegEx = /!\[.*?\]\((.+?)(?:\s+".*?")?\)/g;

/**
 * @type {import('svelte/store').Writable<boolean>}
 */
export const dataLoaded = writable(false);
/**
 * @type {import('svelte/store').Writable<number | undefined>}
 */
export const dataLoadedProgress = writable();
/**
 * @type {import('svelte/store').Writable<CollectionEntryFolder[]>}
 */
export const allEntryFolders = writable([]);
/**
 * @type {import('svelte/store').Writable<Entry[]>}
 */
export const allEntries = writable([]);
/**
 * @type {import('svelte/store').Writable<Error[]>}
 */
export const entryParseErrors = writable([]);
/**
 * @type {import('svelte/store').Writable<Collection | undefined>}
 */
export const selectedCollection = writable();
/**
 * @type {import('svelte/store').Writable<Entry[]>}
 */
export const selectedEntries = writable([]);

/**
 * @type {Map<string, Collection | undefined>}
 */
const collectionCache = new Map();

/**
 * Get a collection by name.
 * @param {string} name - Collection name.
 * @returns {Collection | undefined} Collection, including some extra, normalized properties.
 */
export const getCollection = (name) => {
  const cache = collectionCache.get(name);

  if (cache) {
    return cache;
  }

  const rawCollection = get(siteConfig)?.collections.find((c) => c.name === name);
  const isEntryCollection = typeof rawCollection?.folder === 'string';
  const isFileCollection = !isEntryCollection && Array.isArray(rawCollection?.files);

  // Ignore invalid collection
  if (!isEntryCollection && !isFileCollection) {
    collectionCache.set(name, undefined);

    return undefined;
  }

  const { fields, thumbnail, folder, files } = rawCollection;

  // Normalize folder/file paths by removing leading/trailing slashes
  if (isEntryCollection) {
    rawCollection.folder = stripSlashes(/** @type {string} */ (folder));
  } else {
    /** @type {RawCollectionFile[]} */ (files).forEach((f) => {
      f.file = stripSlashes(f.file);
    });
  }

  const _i18n = getI18nConfig(rawCollection);

  const collectionBase = {
    ...rawCollection,
    _i18n,
    _assetFolder: get(allAssetFolders).find(({ collectionName }) => collectionName === name),
  };

  /** @type {Collection} */
  const collection = isEntryCollection
    ? {
        ...collectionBase,
        _type: /** @type {CollectionType} */ ('entry'),
        _file: getFileConfig({ rawCollection, _i18n }),
        _thumbnailFieldName: rawCollection.folder
          ? (thumbnail ?? fields?.find(({ widget }) => widget === 'image')?.name)
          : undefined,
      }
    : {
        ...collectionBase,
        _type: /** @type {CollectionType} */ ('file'),
        _fileMap: /** @type {RawCollectionFile[]} */ (files)?.length
          ? Object.fromEntries(
              files.map((file) => {
                const __i18n = getI18nConfig(rawCollection, file);
                const __file = getFileConfig({ rawCollection, file, _i18n: __i18n });

                return [file.name, { ...file, _file: __file, _i18n: __i18n }];
              }),
            )
          : {},
      };

  collectionCache.set(name, collection);

  return collection;
};

/**
 * Get collection entry folders that match the given path.
 * @param {string} path - Entry path.
 * @returns {CollectionEntryFolder[]} Entry folders. Sometimes it’s hard to find the right folder
 * because multiple collections can have the same folder or partially overlapping folder paths, but
 * the first one is most likely what you need.
 */
export const getEntryFoldersByPath = (path) =>
  get(allEntryFolders)
    .filter(({ collectionName, filePathMap }) => {
      if (filePathMap) {
        return Object.values(filePathMap).includes(path);
      }

      return /** @type {EntryCollection} */ (
        getCollection(collectionName)
      )?._file?.fullPathRegEx?.test(path);
    })
    .sort((a, b) => b.folderPath?.localeCompare(a.folderPath ?? '') ?? 0);

/**
 * Get a list of collections the given entry belongs to. One entry can theoretically appear in
 * multiple collections depending on the configuration, so that the result is an array.
 * @param {Entry} entry - Entry.
 * @returns {Collection[]} Collections.
 */
export const getCollectionsByEntry = (entry) =>
  getEntryFoldersByPath(Object.values(entry.locales)[0].path)
    .map(({ collectionName }) => getCollection(collectionName))
    .filter((collection) => !!collection);

/**
 * Get a file collection’s file configurations that matches the given entry. One file can
 * theoretically appear in multiple collections files depending on the configuration, so that the
 * result is an array.
 * @param {Collection} collection - Collection.
 * @param {Entry} entry - Entry.
 * @returns {CollectionFile[]} Collection files.
 */
export const getFilesByEntry = (collection, entry) => {
  const _fileMap = collection.files
    ? /** @type {FileCollection} */ (collection)._fileMap
    : undefined;

  if (!_fileMap) {
    // It’s an entry collection
    return [];
  }

  return Object.values(_fileMap).filter(
    ({ _file, _i18n }) => _file.fullPath === entry.locales[_i18n.defaultLocale]?.path,
  );
};

/**
 * Get a file collection entry that matches the given collection name and file name.
 * @param {string} collectionName - Collection name.
 * @param {string} fileName - File name.
 * @returns {Entry | undefined} File.
 * @see https://decapcms.org/docs/collection-types/#file-collections
 */
export const getFile = (collectionName, fileName) =>
  get(allEntries).find((entry) =>
    getCollectionsByEntry(entry).some(
      (collection) =>
        collection.name === collectionName &&
        getFilesByEntry(collection, entry).some((file) => file.name === fileName),
    ),
  );

/**
 * Get entries by the given collection name, while applying a filer if needed.
 * @param {string} collectionName - Collection name.
 * @returns {Entry[]} Entries.
 * @see https://decapcms.org/docs/collection-types#filtered-folder-collections
 */
export const getEntriesByCollection = (collectionName) => {
  const collection = getCollection(collectionName);

  if (!collection) {
    return [];
  }

  const {
    filter,
    _i18n: { defaultLocale: locale },
  } = collection;

  const filterField = filter?.field;

  const filterValues =
    filter?.value === undefined ? [] : Array.isArray(filter.value) ? filter.value : [filter.value];

  return get(allEntries).filter((entry) => {
    if (!getCollectionsByEntry(entry).some(({ name }) => name === collectionName)) {
      return false;
    }

    if (!filterField) {
      return true;
    }

    return filterValues.includes(
      getPropertyValue({ entry, locale, collectionName, key: filterField }),
    );
  });
};

/**
 * Find entries by an asset URL, and replace the URL if needed.
 * @param {string} url - Asset’s public or blob URL.
 * @param {object} [options] - Options.
 * @param {Entry[]} [options.entries] - Entries to be searched.
 * @param {string} [options.newURL] - New URL to replace the found URL.
 * @returns {Promise<Entry[]>} Found (and replaced) entries.
 */
export const getEntriesByAssetURL = async (
  url,
  { entries = get(allEntries), newURL = '' } = {},
) => {
  const siteURL = get(siteConfig)?.site_url;
  const assetURL = siteURL && !url.startsWith('blob:') ? url.replace(siteURL, '') : url;

  const results = await Promise.all(
    entries.map(async (entry) => {
      const { locales } = entry;
      const collections = getCollectionsByEntry(entry);

      const _results = await Promise.all(
        Object.values(locales).map(async ({ content }) => {
          const __results = await Promise.all(
            Object.entries(content).map(async ([keyPath, value]) => {
              if (typeof value !== 'string' || !value) {
                return false;
              }

              const ___results = await Promise.all(
                collections.map(async (collection) => {
                  /**
                   * Check if the field contains the asset.
                   * @param {CollectionFile} [collectionFile] - File. File collection only.
                   * @returns {Promise<boolean>} Result.
                   */
                  const hasAsset = async (collectionFile) => {
                    const field = getFieldConfig({
                      collectionName: collection.name,
                      fileName: collectionFile?.name,
                      valueMap: content,
                      keyPath,
                    });

                    if (!field) {
                      return false;
                    }

                    const { widget: widgetName = 'string' } = field;

                    if (['image', 'file'].includes(widgetName)) {
                      const match = (await getMediaFieldURL(value, entry)) === assetURL;

                      if (match && newURL) {
                        content[keyPath] = newURL;
                      }

                      return match;
                    }

                    // Search images in markdown body
                    if (widgetName === 'markdown') {
                      const matches = [...value.matchAll(markdownImageRegEx)];

                      if (matches.length) {
                        return (
                          await Promise.all(
                            matches.map(async ([, src]) => {
                              const match = (await getMediaFieldURL(src, entry)) === assetURL;

                              if (match && newURL) {
                                content[keyPath] = content[keyPath].replace(src, newURL);
                              }

                              return match;
                            }),
                          )
                        ).some(Boolean);
                      }
                    }

                    return false;
                  };

                  const collectionFiles = getFilesByEntry(collection, entry);

                  if (collectionFiles.length) {
                    return (await Promise.all(collectionFiles.map(hasAsset))).includes(true);
                  }

                  return hasAsset();
                }),
              );

              return ___results.includes(true);
            }),
          );

          return __results.includes(true);
        }),
      );

      return _results.includes(true);
    }),
  );

  return entries.filter((_entry, index) => results[index]);
};
