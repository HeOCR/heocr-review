/**
 * Contribution terms shown before a volunteer's first decision.
 *
 * DRAFT: the maintainer must approve this text before public launch. Bump TERMS_VERSION whenever the text
 * changes; every reviewer is then asked again before their next decision.
 */
export const TERMS_STATUS = "DRAFT" as const;
export const TERMS_VERSION = "2026-11-07-draft-1";
export const TERMS_LICENSE = "CC BY-SA 4.0";
export const TERMS_LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";
/** The public pages carry the same versions (test/node/pages.test.ts checks them). */
export const PRIVACY_VERSION = "2026-11-07-draft-1";
export const CONTACT_EMAIL = "heocrproject@gmail.com";

export interface TermsText {
  title: string;
  paragraphs: string[];
  creditOptIn: string;
  accept: string;
}

export const TERMS_HE: TermsText = {
  title: "תנאי תרומה",
  paragraphs: [
    "ב-HeOCR Review אתם בודקים הצעות לתיקון טקסט מול סריקות של דפים מודפסים.",
    "ההחלטות שלכם והטקסט שאתם עורכים נתרמים לפרויקט HeOCR ברישיון CC BY-SA 4.0, כמו טקסט ויקיטקסט.",
    "הקרדיט ניתן בכינוי אקראי (למשל rv_1a2b3c4d). איננו שומרים את כתובת הדוא״ל או את שמכם בגוגל.",
    "אפשר לבחור שם תצוגה לקרדיט. זה רשות, ואפשר לבטל בכל עת.",
  ],
  creditOptIn: "אני רוצה קרדיט בשם התצוגה הזה:",
  accept: "אני מסכים/ה ומתחיל/ה",
};

export const TERMS_EN: TermsText = {
  title: "Contribution terms",
  paragraphs: [
    "In HeOCR Review you check proposed text corrections against scans of printed pages.",
    "Your decisions and any text you edit are contributed to the HeOCR project under CC BY-SA 4.0, the same licence as Wikisource text.",
    "You are credited by a random pseudonym (such as rv_1a2b3c4d). We do not store your email address or your Google name.",
    "You may choose a display name to be credited by instead. This is optional, and you can withdraw it at any time.",
  ],
  creditOptIn: "Credit me by this display name:",
  accept: "I agree, start reviewing",
};
