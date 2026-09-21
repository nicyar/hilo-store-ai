import { useRef } from "react";
import { ENABLED_AUTH_METHODS } from "../../config/authConfig.js";
import "./AuthTabs.css";

const TAB_LABELS = {
  password: "Email",
  google: "Google",
  phone: "Teléfono",
};

// Este componente ya solo se monta cuando hay 2+ métodos habilitados (ver
// AuthContainer.jsx) -- igual arma la lista a partir de ENABLED_AUTH_METHODS
// en vez de asumir 3, para no romper la navegación con flechas si el día de
// mañana se agrega un cuarto método.
const TABS = ENABLED_AUTH_METHODS.map((id) => ({ id, label: TAB_LABELS[id] }));

/**
 * Patrón ARIA "tabs" completo: role=tablist/tab/tabpanel, roving
 * tabindex y navegación con flechas/Home/End, no solo con mouse.
 */
export default function AuthTabs({ activeTab, onChange }) {
  const tabRefs = useRef({});

  function focusTab(id) {
    tabRefs.current[id]?.focus();
  }

  function handleKeyDown(event, index) {
    let nextIndex = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;

    if (nextIndex !== null) {
      event.preventDefault();
      const nextTab = TABS[nextIndex];
      onChange(nextTab.id);
      focusTab(nextTab.id);
    }
  }

  return (
    <div className="auth-tabs" role="tablist" aria-label="Método para ingresar">
      {TABS.map((tab, index) => {
        const selected = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[tab.id] = el;
            }}
            role="tab"
            type="button"
            id={`auth-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`auth-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            className={`auth-tabs__tab${selected ? " auth-tabs__tab--active" : ""}`}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
