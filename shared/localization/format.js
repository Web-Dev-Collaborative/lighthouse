/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const fs = require('fs');

const {isObjectOfUnknownValues, isObjectOrArrayOfUnknownValues} = require('../type-verifiers.js');
const {_formatMessage, collectAllCustomElementsFromICU} = require('./message.js');

/** Contains available locales with messages. May be an empty object if bundled. */
const LOCALE_MESSAGES = require('./locales.js');

/**
 * The locale tags for the localized messages available to Lighthouse on disk.
 * When bundled, these will be inlined by brfs.
 * These locales are considered the "canonical" locales. We support other locales which
 * are simply aliases to one of these. ex: es-AR (alias) -> es-419 (canonical)
 */
let CANONICAL_LOCALES = ['__availableLocales__'];
// TODO: need brfs in gh-pages-app. For now, above is replaced, see build-i18n.module.js
if (fs.readdirSync) {
  CANONICAL_LOCALES = fs.readdirSync(__dirname + '/locales/')
    .filter(basename => basename.endsWith('.json') && !basename.endsWith('.ctc.json'))
    .map(locale => locale.replace('.json', ''))
    .sort();
}

const MESSAGE_I18N_ID_REGEX = / | [^\s]+$/;

/**
 * Retrieves the localized version of `icuMessage` and formats with any given
 * value replacements.
 * @param {LH.IcuMessage} icuMessage
 * @param {LH.Locale} locale
 * @return {string}
 */
function _localizeIcuMessage(icuMessage, locale) {
  const localeMessages = LOCALE_MESSAGES[locale];
  if (!localeMessages) throw new Error(`Unsupported locale '${locale}'`);
  const localeMessage = localeMessages[icuMessage.i18nId];

  // Fall back to the default (usually the original english message) if we couldn't find a
  // message in the specified locale. This could be because of string drift between
  // Lighthouse versions or because new strings haven't been updated yet. Better to have
  // an english message than no message at all; in some cases it won't even matter.
  if (!localeMessage) {
    return icuMessage.formattedDefault;
  }

  return _formatMessage(localeMessage.message, icuMessage.values, locale);
}

/**
 * @param {LH.Locale} locale
 * @return {Record<string, string>}
 */
function getRendererFormattedStrings(locale) {
  const localeMessages = LOCALE_MESSAGES[locale];
  if (!localeMessages) throw new Error(`Unsupported locale '${locale}'`);

  const icuMessageIds = Object.keys(localeMessages).filter(f => f.startsWith('report/'));
  /** @type {Record<string, string>} */
  const strings = {};
  for (const icuMessageId of icuMessageIds) {
    const {filename, key} = getIcuMessageIdParts(icuMessageId);
    if (!filename.endsWith('util.js')) throw new Error(`Unexpected message: ${icuMessageId}`);

    strings[key] = localeMessages[icuMessageId].message;
  }

  return strings;
}

/**
 * Returns whether `icuMessageOrNot`` is an `LH.IcuMessage` instance.
 * @param {unknown} icuMessageOrNot
 * @return {icuMessageOrNot is LH.IcuMessage}
 */
function isIcuMessage(icuMessageOrNot) {
  if (!isObjectOfUnknownValues(icuMessageOrNot)) {
    return false;
  }

  const {i18nId, values, formattedDefault} = icuMessageOrNot;
  if (typeof i18nId !== 'string') {
    return false;
  }

  // formattedDefault is required.
  if (typeof formattedDefault !== 'string') {
    return false;
  }

  // Values is optional.
  if (values !== undefined) {
    if (!isObjectOfUnknownValues(values)) {
      return false;
    }
    for (const value of Object.values(values)) {
      if (typeof value !== 'string' && typeof value !== 'number') {
        return false;
      }
    }
  }

  // Finally return true if i18nId seems correct.
  return MESSAGE_I18N_ID_REGEX.test(i18nId);
}

/**
 * Get the localized and formatted form of `icuMessageOrRawString` if it's an
 * LH.IcuMessage, or get it back directly if it's already a string.
 * Warning: this function throws if `icuMessageOrRawString` is not the expected
 * type (use function from `createIcuMessageFn` to create a valid LH.IcuMessage)
 * or `locale` isn't supported (use `lookupLocale` to find a valid locale).
 * @param {LH.IcuMessage | string} icuMessageOrRawString
 * @param {LH.Locale} locale
 * @return {string}
 */
function getFormatted(icuMessageOrRawString, locale) {
  if (isIcuMessage(icuMessageOrRawString)) {
    return _localizeIcuMessage(icuMessageOrRawString, locale);
  }

  if (typeof icuMessageOrRawString === 'string') {
    return icuMessageOrRawString;
  }

  // Should be impossible from types, but do a strict check in case malformed JSON makes it this far.
  throw new Error('Attempted to format invalid icuMessage type');
}

/** @param {string[]} pathInLHR */
function _formatPathAsString(pathInLHR) {
  let pathAsString = '';
  for (const property of pathInLHR) {
    if (/^[a-z]+$/i.test(property)) {
      if (pathAsString.length) pathAsString += '.';
      pathAsString += property;
    } else {
      if (/]|"|'|\s/.test(property)) throw new Error(`Cannot handle "${property}" in i18n`);
      pathAsString += `[${property}]`;
    }
  }

  return pathAsString;
}

/**
 * Recursively walk the input object, looking for property values that are
 * `LH.IcuMessage`s and replace them with their localized values. Primarily
 * used with the full LHR or a Config as input.
 * Returns a map of locations that were replaced to the `IcuMessage` that was at
 * that location.
 * @param {unknown} inputObject
 * @param {LH.Locale} locale
 * @return {LH.Result.IcuMessagePaths}
 */
function replaceIcuMessages(inputObject, locale) {
  /**
   * @param {unknown} subObject
   * @param {LH.Result.IcuMessagePaths} icuMessagePaths
   * @param {string[]} pathInLHR
   */
  function replaceInObject(subObject, icuMessagePaths, pathInLHR = []) {
    if (!isObjectOrArrayOfUnknownValues(subObject)) return;

    for (const [property, possibleIcuMessage] of Object.entries(subObject)) {
      const currentPathInLHR = pathInLHR.concat([property]);

      // Replace any IcuMessages with a localized string.
      if (isIcuMessage(possibleIcuMessage)) {
        const formattedString = getFormatted(possibleIcuMessage, locale);
        const messageInstancesInLHR = icuMessagePaths[possibleIcuMessage.i18nId] || [];
        const currentPathAsString = _formatPathAsString(currentPathInLHR);

        messageInstancesInLHR.push(
          possibleIcuMessage.values ?
            {values: possibleIcuMessage.values, path: currentPathAsString} :
            currentPathAsString
        );

        // @ts-ignore - tsc doesn't like that `property` can be either string key or array index.
        subObject[property] = formattedString;
        icuMessagePaths[possibleIcuMessage.i18nId] = messageInstancesInLHR;
      } else {
        replaceInObject(possibleIcuMessage, icuMessagePaths, currentPathInLHR);
      }
    }
  }

  /** @type {LH.Result.IcuMessagePaths} */
  const icuMessagePaths = {};
  replaceInObject(inputObject, icuMessagePaths);
  return icuMessagePaths;
}

/**
 * Returns whether the `requestedLocale` can be used.
 * @param {LH.Locale} requestedLocale
 * @return {boolean}
 */
function hasLocale(requestedLocale) {
  const hasIntlSupport = Intl.NumberFormat.supportedLocalesOf([requestedLocale]).length > 0;
  const hasMessages = Boolean(LOCALE_MESSAGES[requestedLocale]);

  return hasIntlSupport && hasMessages;
}

/**
 * Returns a list of canonical locales (each of which may have aliases, but those would
 * only show in getAvailableLocales)
 * TODO: create a CanonicalLocale type
 * @return {Array<string>}
 */
function getCanonicalLocales() {
  return CANONICAL_LOCALES;
}

/**
 * Returns a list of available locales.
 *  - if full build, this includes all canonical locales, aliases, and any locale added
 *      via `registerLocaleData`.
 *  - if bundled and locale messages have been stripped (locales.js shimmed), this includes no
 *      locales (perhaps available in a separate bundle), and perhaps any locales
 *      from `registerLocaleData`.
 * @return {Array<LH.Locale>}
 */
function getAvailableLocales() {
  return /** @type {Array<LH.Locale>} */ (Object.keys(LOCALE_MESSAGES).sort());
}

/**
 * Populate the i18n string lookup dict with locale data
 * Used when the host environment selects the locale and serves lighthouse the intended locale file
 * @see https://docs.google.com/document/d/1jnt3BqKB-4q3AE94UWFA0Gqspx8Sd_jivlB7gQMlmfk/edit
 * @param {LH.Locale} locale
 * @param {import('./locales').LhlMessages} lhlMessages
 */
function registerLocaleData(locale, lhlMessages) {
  LOCALE_MESSAGES[locale] = lhlMessages;
}

/**
 * @param {string} i18nMessageId
 */
function getIcuMessageIdParts(i18nMessageId) {
  if (!MESSAGE_I18N_ID_REGEX.test(i18nMessageId)) {
    throw Error(`"${i18nMessageId}" does not appear to be a valid ICU message id`);
  }
  const [filename, key] = i18nMessageId.split(' | ');
  return {filename, key};
}

module.exports = {
  _formatPathAsString,
  collectAllCustomElementsFromICU,
  isIcuMessage,
  getFormatted,
  getRendererFormattedStrings,
  replaceIcuMessages,
  hasLocale,
  registerLocaleData,
  _formatMessage,
  getIcuMessageIdParts,
  getAvailableLocales,
  getCanonicalLocales,
};
