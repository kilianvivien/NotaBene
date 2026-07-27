/** i18n bootstrap. EN and FR are both first-class from day one — every string
 * that ships in one locale ships in the other (house rule). */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@/locales/en/common.json';
import fr from '@/locales/fr/common.json';

export const SUPPORTED_LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

void i18n.use(initReactI18next).init({
  resources: {
    en: { common: en },
    fr: { common: fr },
  },
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  interpolation: { escapeValue: false },
});

export function setLocale(locale: Locale): void {
  void i18n.changeLanguage(locale);
}

export default i18n;
