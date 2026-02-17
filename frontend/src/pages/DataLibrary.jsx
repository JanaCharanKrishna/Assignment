import React from "react";
import { useNavigate } from "react-router-dom";
import { IconEye } from "@tabler/icons-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const API_BASE = import.meta.env.VITE_API_BASE?.trim() || "http://localhost:5000";

function formatUploadedAt(value) {
  const d = new Date(value || "");
  if (!Number.isFinite(d.getTime())) return "-";
  return d.toLocaleString();
}

export default function DataLibrary() {
  const navigate = useNavigate();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [wells, setWells] = React.useState([]);

  React.useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`${API_BASE}/api/wells`);
        const text = await res.text();
        const json = text ? JSON.parse(text) : {};
        if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
        if (active) setWells(Array.isArray(json?.wells) ? json.wells : []);
      } catch (e) {
        if (active) setError(e?.message || "Failed to load data library");
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="dash-heading">Data Library</h1>
        <p className="dash-subtle">Available uploaded wells and metadata.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Wells</CardTitle>
          <CardDescription>{loading ? "Loading..." : `${wells.length} items`}</CardDescription>
        </CardHeader>
        <CardContent>
          {error ? <p className="mb-3 text-sm text-rose-400">{error}</p> : null}
          <div className="rounded-md border border-white/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Well ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Uploaded At</TableHead>
                  <TableHead className="text-right">Points</TableHead>
                  <TableHead className="text-right">View</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!loading && wells.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                      No wells found.
                    </TableCell>
                  </TableRow>
                ) : (
                  wells.map((well) => (
                    <TableRow key={well.wellId}>
                      <TableCell className="font-medium">{well.wellId}</TableCell>
                      <TableCell>{well.name || "-"}</TableCell>
                      <TableCell>{formatUploadedAt(well.createdAt || well.uploadedAt)}</TableCell>
                      <TableCell className="text-right">{Number(well.pointCount || 0)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() =>
                            navigate(`/?wellId=${encodeURIComponent(String(well.wellId || ""))}`)
                          }
                          title="Open this well in main page"
                          aria-label={`Open ${well.wellId} in main page`}
                        >
                          <IconEye className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
