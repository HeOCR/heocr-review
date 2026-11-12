/**
 * Contribution terms shown before a volunteer's first decision.
 *
 * Approved by the maintainer on 2026-11-07 as version 2026-11-07-v1 (docs/decisions/2026-11-07-terms-approved.md);
 * contributions relicensed to CC0 1.0 on 2026-11-12 as version 2026-11-12-v1 (docs/decisions/2026-11-12-cc0.md).
 * Any change to this text, public/terms.html or public/privacy.html needs the maintainer's approval and a new
 * version; on a new TERMS_VERSION every reviewer is asked again before their next decision.
 */
export const TERMS_STATUS = "APPROVED" as const;
export const TERMS_VERSION = "2026-11-12-v1";
export const TERMS_LICENSE = "CC0 1.0";
export const TERMS_LICENSE_URL = "https://creativecommons.org/publicdomain/zero/1.0/";
/** The public pages carry the same versions (test/node/pages.test.ts checks them). */
export const PRIVACY_VERSION = "2026-11-12-v1";
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
    "ההחלטות שלכם והטקסט שאתם עורכים נתרמים לפרויקט HeOCR ומוקדשים לנחלת הכלל לפי CC0 1.0. זה חל על התרומה שלכם בלבד: טקסט שממנו אתם מתחילים שומר על הרישיון שלו (טקסט ויקיטקסט, למשל, נשאר ב-CC BY-SA 4.0).",
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
    "Your decisions and any text you edit are contributed to the HeOCR project and dedicated to the public domain under CC0 1.0. This covers your own contribution only: text you start from keeps its own licence (Wikisource text, for example, stays CC BY-SA 4.0).",
    "You are credited by a random pseudonym (such as rv_1a2b3c4d). We do not store your email address or your Google name.",
    "You may choose a display name to be credited by instead. This is optional, and you can withdraw it at any time.",
  ],
  creditOptIn: "Credit me by this display name:",
  accept: "I agree, start reviewing",
};
