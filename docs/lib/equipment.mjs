/** Shared equipment checks. Only confirmed constraints are encoded. */

export const LAT_LOADS_KG = [59, 66];
const GRID_EPSILON = 1e-6;

export function equipmentLoadOk(equipment, kg) {
  if (typeof kg !== "number" || !Number.isFinite(kg) || kg < 0 || kg > 500) return false;
  if (equipment === "lat") {
    return LAT_LOADS_KG.some((allowed) => Math.abs(kg - allowed) <= GRID_EPSILON);
  }
  if (equipment === "dumbbell" && kg > 10) {
    const nearest = Math.round(kg / 2.5) * 2.5;
    return Math.abs(kg - nearest) <= GRID_EPSILON;
  }
  return true;
}

export function dumbbellStepOk(kg) {
  return equipmentLoadOk("dumbbell", kg);
}

export function latWeightOk(kg) {
  return equipmentLoadOk("lat", kg);
}

export function validateActualLoad(step, weightKg) {
  if (!step.load) {
    if (weightKg != null) return { ok: false, message: "Steget har ingen vikt." };
    return { ok: true, weightKg: null };
  }
  if (weightKg == null || Number.isNaN(weightKg)) {
    return { ok: false, message: "Ange vikt. Okänd vikt blir inte noll." };
  }
  if (!equipmentLoadOk(step.equipment, weightKg)) {
    if (step.equipment === "lat") {
      return { ok: false, message: "Känd lat-stack är bara 59 eller 66 kg. Annan vikt är okänd, inte ett mellansteg." };
    }
    if (step.equipment === "dumbbell") {
      return { ok: false, message: "Hantlar över 10 kg endast i steg om 2,5 kg." };
    }
    return { ok: false, message: "Ogiltig vikt." };
  }
  return { ok: true, weightKg };
}

export function loadModeLabel(mode) {
  if (mode === "per_hand") return "per hand";
  if (mode === "stack") return "stack";
  if (mode === "total") return "totalt";
  return "";
}

export function sideLabel(side) {
  if (side === "left") return "vänster";
  if (side === "right") return "höger";
  if (side === "both") return "båda";
  return "—";
}
