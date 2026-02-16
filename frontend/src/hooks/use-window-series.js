import React from "react";
import { API_BASE } from "../components/chart/chart-utils";

export function useWindowSeries({ wellId, metric, from, to, pixelWidth }) {
  const [data, setData] = React.useState(null);
  const [plan, setPlan] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let alive = true;
    if (!wellId || !metric || !Number.isFinite(Number(from)) || !Number.isFinite(Number(to))) {
      setData(null);
      setPlan(null);
      setError("");
      return () => {
        alive = false;
      };
    }

    (async () => {
      setLoading(true);
      setError("");
      try {
        const q = `metric=${encodeURIComponent(metric)}&from=${Number(from)}&to=${Number(to)}&pixelWidth=${Math.max(
          200,
          Number(pixelWidth) || 1200
        )}`;

        const planRes = await fetch(`${API_BASE}/api/well/${wellId}/window-plan?${q}`);
        const planJson = await planRes.json();
        if (!planRes.ok) throw new Error(planJson?.error || "window-plan failed");
        if (!alive) return;
        setPlan(planJson);

        const dataRes = await fetch(`${API_BASE}/api/well/${wellId}/window-data?${q}`);
        const dataJson = await dataRes.json();
        if (!dataRes.ok) throw new Error(dataJson?.error || "window-data failed");
        if (!alive) return;
        setData(dataJson);

        if (dataJson?.completeness === "partial" && dataJson?.refresh?.recommended) {
          const afterMs = Math.max(200, Number(dataJson?.refresh?.afterMs) || 600);
          await new Promise((resolve) => setTimeout(resolve, afterMs));
          if (!alive) return;
          const dataRes2 = await fetch(`${API_BASE}/api/well/${wellId}/window-data?${q}`);
          const dataJson2 = await dataRes2.json();
          if (!dataRes2.ok) throw new Error(dataJson2?.error || "window-data refresh failed");
          if (!alive) return;
          setData(dataJson2);
        }
      } catch (e) {
        if (!alive) return;
        setError(e?.message || "Failed to load window series");
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [wellId, metric, from, to, pixelWidth]);

  return { data, plan, loading, error };
}
