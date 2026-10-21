/**
 * Thriva biomarker ID to human-readable name and category mapping
 *
 * Categories group related biomarkers for easier querying and visualization
 */

export interface BiomarkerInfo {
  name: string;
  category: string;
  description?: string;
}

export const BIOMARKER_MAP: Record<string, BiomarkerInfo> = {
  // Vitamins
  "AB12": { name: "Vitamin B12", category: "vitamins" },
  "VIDC": { name: "Vitamin D", category: "vitamins" },
  "FOLA": { name: "Folate", category: "vitamins" },

  // Iron
  "FERR": { name: "Ferritin", category: "iron" },

  // Thyroid
  "TSH": { name: "TSH", category: "thyroid", description: "Thyroid Stimulating Hormone" },
  "FT4": { name: "Free T4", category: "thyroid" },
  "FT3": { name: "Free T3", category: "thyroid" },

  // Lipids / Cardiovascular
  "CHO": { name: "Total Cholesterol", category: "lipids" },
  "HDL": { name: "HDL Cholesterol", category: "lipids" },
  "LDL": { name: "LDL Cholesterol", category: "lipids" },
  "TRI": { name: "Triglycerides", category: "lipids" },
  "NHDF": { name: "Non-HDL Cholesterol", category: "lipids" },
  "CHDD": { name: "Cholesterol/HDL Ratio", category: "lipids" },
  "THR": { name: "TG/HDL Ratio", category: "lipids" },
  "APOA": { name: "Apolipoprotein A", category: "lipids" },
  "APOB": { name: "Apolipoprotein B", category: "lipids" },
  "APOR": { name: "ApoB/ApoA Ratio", category: "lipids" },
  "LPOA": { name: "Lipoprotein(a)", category: "lipids" },

  // Diabetes / Blood Sugar
  "GHBI": { name: "HbA1c", category: "diabetes", description: "Glycated Haemoglobin" },
  "GHB": { name: "HbA1c", category: "diabetes" },

  // Inflammation
  "CRP": { name: "CRP", category: "inflammation", description: "C-Reactive Protein" },
  "HOMO": { name: "Homocysteine", category: "inflammation" },

  // Liver
  "ALT": { name: "ALT", category: "liver", description: "Alanine Aminotransferase" },
  "GGT": { name: "GGT", category: "liver", description: "Gamma-Glutamyl Transferase" },
  "ALP": { name: "ALP", category: "liver", description: "Alkaline Phosphatase" },
  "BILI": { name: "Bilirubin", category: "liver" },
  "ALB": { name: "Albumin", category: "liver" },
  "GLOB": { name: "Globulin", category: "liver" },
  "PROT": { name: "Total Protein", category: "liver" },

  // Kidney
  "CREA": { name: "Creatinine", category: "kidney" },
  "GFR": { name: "eGFR", category: "kidney", description: "Estimated Glomerular Filtration Rate" },
  "UA": { name: "Uric Acid", category: "kidney" },

  // Hormones
  "TEST": { name: "Testosterone", category: "hormones" },
  "FTEST": { name: "Free Testosterone", category: "hormones" },
  "FTEST2": { name: "Free Testosterone (calc)", category: "hormones" },
  "SHBG": { name: "SHBG", category: "hormones", description: "Sex Hormone Binding Globulin" },
  "FAI": { name: "Free Androgen Index", category: "hormones" },

  // Prostate
  "PSA": { name: "PSA", category: "prostate", description: "Prostate Specific Antigen" },

  // Other
  "OMGI": { name: "Omega-3 Index", category: "nutrition" },
  "ISP": { name: "Iron Saturation", category: "iron" },
  "TF": { name: "Transferrin", category: "iron" },
  "TF2": { name: "Transferrin Saturation", category: "iron" },
  "BVIT": { name: "B Vitamins", category: "vitamins" },
  "LIPP": { name: "Lipid Panel", category: "lipids" },
  "LFT": { name: "Liver Function", category: "liver" },
  "APLIP": { name: "Advanced Lipids", category: "lipids" },
};

/**
 * Get biomarker info, falling back to ID-based defaults if not found
 */
export function getBiomarkerInfo(id: string): BiomarkerInfo {
  return BIOMARKER_MAP[id] || {
    name: id,
    category: "other",
  };
}

/**
 * Get all unique categories
 */
export function getCategories(): string[] {
  const categories = new Set(Object.values(BIOMARKER_MAP).map((b) => b.category));
  return Array.from(categories).sort();
}
