/**
 * Thriva test profile mapping
 *
 * Test profiles are the selectable components when building a Thriva test kit.
 * Each profile contains one or more biomarker measurements.
 */

import { getBiomarkerInfo } from "./thriva-biomarkers";

export interface TestProfile {
  name: string;
  description: string;
  biomarkers: string[]; // Biomarker codes included in this profile
}

/**
 * Map of profile codes to their metadata
 * Note: biomarkers arrays are derived from actual API responses
 */
export const TEST_PROFILE_MAP: Record<string, TestProfile> = {
  // Vitamins
  AB12: {
    name: "Vitamin B12",
    description: "Active B12 levels",
    biomarkers: ["AB12"],
  },
  VITD: {
    name: "Vitamin D",
    description: "25-OH Vitamin D levels",
    biomarkers: ["VIDC"],
  },
  BVIT: {
    name: "B Vitamins",
    description: "B12 and Folate",
    biomarkers: ["FOLA", "AB12"],
  },

  // Lipids
  LIPP: {
    name: "Lipid Panel",
    description: "Basic cholesterol panel",
    biomarkers: ["TRI", "CHO", "LDL", "HDL", "NHDF", "CHDD", "THR", "HCR"],
  },
  APLIP: {
    name: "Advanced Lipids",
    description: "Extended lipid panel with apolipoprotein markers",
    biomarkers: ["APOA", "APOB", "APOR", "THR", "LDL", "NHDF", "HDL", "CHO", "HCR", "TRI", "CHDD"],
  },

  // Liver
  LFT: {
    name: "Liver Function",
    description: "Liver enzyme panel",
    biomarkers: ["BILI", "ALP", "GGT", "PROT", "ALB", "GLOB", "ALT"],
  },

  // Kidney
  CREA: {
    name: "Kidney Function",
    description: "Creatinine and eGFR",
    biomarkers: ["CREA", "GFR"],
  },

  // Thyroid
  TF: {
    name: "Thyroid Function",
    description: "TSH and Free T4",
    biomarkers: ["TSH", "FT4"],
  },

  // Hormones
  TEST: {
    name: "Testosterone",
    description: "Total testosterone",
    biomarkers: ["TEST"],
  },
  FTEST: {
    name: "Free Testosterone",
    description: "Free testosterone with SHBG and calculated indices",
    biomarkers: ["SHBG", "FAI", "TEST", "FTEST", "ALB"],
  },

  // Iron
  FERR: {
    name: "Ferritin",
    description: "Iron stores",
    biomarkers: ["FERR"],
  },
  ISP: {
    name: "Iron Status Panel",
    description: "Complete iron panel including ferritin, transferrin saturation, and TIBC",
    biomarkers: ["TIBC", "FESA", "FERR", "FE", "UIBC"],
  },

  // Inflammation
  CRP: {
    name: "CRP",
    description: "C-Reactive Protein inflammation marker",
    biomarkers: ["CRP"],
  },

  // Diabetes
  GHB: {
    name: "HbA1c",
    description: "Average blood sugar over 2-3 months",
    biomarkers: ["GHBI"],
  },
};

/**
 * Get profile info, falling back to code-based defaults if not found
 */
export function getProfileInfo(code: string): TestProfile {
  return (
    TEST_PROFILE_MAP[code] || {
      name: code,
      description: "Unknown profile",
      biomarkers: [],
    }
  );
}

/**
 * Get profile info with resolved biomarker names
 */
export function getProfileWithBiomarkerNames(code: string): {
  code: string;
  name: string;
  description: string;
  biomarkerNames: string[];
} {
  const profile = getProfileInfo(code);
  return {
    code,
    name: profile.name,
    description: profile.description,
    biomarkerNames: profile.biomarkers.map((id) => getBiomarkerInfo(id).name),
  };
}

/**
 * Get all profiles sorted alphabetically by name
 */
export function getAllProfiles(): Array<{
  code: string;
  name: string;
  description: string;
  biomarkerNames: string[];
}> {
  return Object.keys(TEST_PROFILE_MAP)
    .map(getProfileWithBiomarkerNames)
    .sort((a, b) => a.name.localeCompare(b.name));
}
