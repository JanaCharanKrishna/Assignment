import React from "react";
import {
  Route,
  createBrowserRouter,
  createRoutesFromElements,
  RouterProvider,
} from "react-router-dom";
import MainLayout from "./layouts/MainLayout";
import Overview from "./pages/Overview";
import DataLibrary from "./pages/DataLibrary";
import Reports from "./pages/Reports";

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route path="/" element={<MainLayout />}>
      <Route index element={<Overview />} />
      <Route path="reports" element={<Reports />} />
      <Route path="datalibrary" element={<DataLibrary />} />
    </Route>
  )
);

export default function App() {
  return <RouterProvider router={router} />;
}
