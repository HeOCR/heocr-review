/**
 * Contribution terms shown before a volunteer's first decision.
 *
 * Approved by the maintainer on 2026-11-07 as version 2026-11-07-v1 (docs/decisions/2026-11-07-terms-approved.md);
 * contributions relicensed to CC0 1.0 on 2026-11-12 as version 2026-11-12-v1 (docs/decisions/2026-11-12-cc0.md).
 * Privacy policy 2026-11-16-v1: unsaved page corrections kept on the server (docs/decisions/2026-11-16-drafts-privacy.md);
 * privacy policy 2026-11-16-v2: what a deletion on request does with unpublished decisions
 * (docs/decisions/2026-11-16-reviewer-deletion.md); privacy policy 2026-11-18-v3: check lines and accuracy in the
 * volunteer line review (docs/decisions/2026-11-18-check-lines.md). Each time the terms are unchanged, so nobody is
 * asked to accept again.
 * Privacy policy 2026-11-20-v1: admin synthetic realism review (docs/decisions/2026-11-20-synth-realism.md).
 * Privacy policy 2026-11-20-v2: training page transcription (docs/decisions/2026-11-20-page-paste-train.md).
 * Terms 2026-11-18-v1: the scope covers handwritten pages and typing text, and CC0 covers text you type
 * (docs/decisions/2026-11-18-terms-handwriting.md); every reviewer is asked again.
 * Any change to this text, public/terms.html or public/privacy.html needs the maintainer's approval and a new
 * version; on a new TERMS_VERSION every reviewer is asked again before their next decision.
 */
export const TERMS_STATUS = "APPROVED" as const;
export const TERMS_VERSION = "2026-11-18-v1";
export const TERMS_LICENSE = "CC0 1.0";
export const TERMS_LICENSE_URL = "https://creativecommons.org/publicdomain/zero/1.0/";
/** The public pages carry the same versions (test/node/pages.test.ts checks them). */
export const PRIVACY_VERSION = "2026-11-20-v2";
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
    "ב-HeOCR Review אתם עובדים על טקסט מול סריקות של דפים מודפסים וכתבי יד: בודקים הצעות לתיקון, או מקלידים את הטקסט מהסריקה.",
    "ההחלטות שלכם והטקסט שאתם עורכים או מקלידים נתרמים לפרויקט HeOCR ומוקדשים לנחלת הכלל לפי CC0 1.0. זה חל על התרומה שלכם בלבד: טקסט שממנו אתם מתחילים שומר על הרישיון שלו (טקסט ויקיטקסט, למשל, נשאר ב-CC BY-SA 4.0).",
    "הקרדיט ניתן בכינוי אקראי (למשל rv_1a2b3c4d). איננו שומרים את כתובת הדוא״ל או את שמכם בגוגל.",
    "אפשר לבחור שם תצוגה לקרדיט. זה רשות, ואפשר לבטל בכל עת.",
  ],
  creditOptIn: "אני רוצה קרדיט בשם התצוגה הזה:",
  accept: "אני מסכים/ה ומתחיל/ה",
};

export const TERMS_EN: TermsText = {
  title: "Contribution terms",
  paragraphs: [
    "In HeOCR Review you work on text against scans of printed and handwritten pages: you check proposed corrections, or type the text from the scan.",
    "Your decisions and any text you edit or type are contributed to the HeOCR project and dedicated to the public domain under CC0 1.0. This covers your own contribution only: text you start from keeps its own licence (Wikisource text, for example, stays CC BY-SA 4.0).",
    "You are credited by a random pseudonym (such as rv_1a2b3c4d). We do not store your email address or your Google name.",
    "You may choose a display name to be credited by instead. This is optional, and you can withdraw it at any time.",
  ],
  creditOptIn: "Credit me by this display name:",
  accept: "I agree, start reviewing",
};
