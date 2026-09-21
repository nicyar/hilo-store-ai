import { useState } from "react";
import AuthContainer from "./components/auth/AuthContainer.jsx";
import ResetPasswordForm from "./components/auth/ResetPasswordForm.jsx";
import "./App.css";

// Etapa 1: la app React de HILO Store es, por ahora, únicamente el
// flujo de autenticación. Home/catálogo migran en una etapa futura
// todavía no arrancada (ver decisión de arquitectura documentada
// en el reporte de esta entrega).
//
// Recuperación de contraseña: por contrato, el link que llega por
// email apunta a la RAÍZ de esta app con query params
// (?view=reset-password&token=...), no a una ruta nueva del server.
// Hoy no hay ningún router instalado en frontend/ (ver package.json)
// y no vale la pena sumar uno solo para esta pantalla. Este es un
// STOPGAP explícito: se lee window.location.search UNA sola vez al
// montar para decidir qué pantalla mostrar. Cuando llegue la
// migración completa del sitio a React (próxima etapa) con un router
// real, esto se reemplaza por una ruta propiamente dicha.
function getInitialView() {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "reset-password" ? "reset-password" : "auth";
}

export default function App() {
  const [view] = useState(getInitialView);

  return (
    <div className="app-shell">
      {view === "reset-password" ? <ResetPasswordForm /> : <AuthContainer />}
    </div>
  );
}
