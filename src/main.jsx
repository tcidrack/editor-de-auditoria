import { StrictMode, Component } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import EditorAuditoria from "./EditorAuditoria.jsx";

// rede de segurança: sem isto, um erro no render derruba a árvore e sobra uma página em branco,
// sem pista nenhuma para quem está auditando. O estilo é inline de propósito — o erro pode ter
// vindo justamente do editor, então esta tela não depende de nada dele.
class ErroFatal extends Component {
  state = { erro: null };
  static getDerivedStateFromError(erro) { return { erro }; }
  componentDidCatch(erro, info) { console.error("Erro no editor:", erro, info); }
  render() {
    const { erro } = this.state;
    if (!erro) return this.props.children;
    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24, background: "#0f172a", color: "#e2e8f0",
        font: "14px/1.5 system-ui, Segoe UI, sans-serif",
      }}>
        <div style={{ maxWidth: 560, width: "100%" }}>
          <b style={{ fontSize: 18 }}>⚠ Algo quebrou no editor</b>
          <pre style={{
            marginTop: 12, padding: 12, borderRadius: 8, overflow: "auto",
            background: "#1e293b", color: "#fca5a5", fontSize: 12, whiteSpace: "pre-wrap",
          }}>{String((erro && erro.message) || erro)}</pre>
          <p style={{ marginTop: 12, color: "#94a3b8" }}>
            Seu rascunho continua salvo neste navegador — recarregar não perde o trabalho.
          </p>
          <button onClick={() => location.reload()}
            style={{
              marginTop: 12, padding: "8px 16px", borderRadius: 8, border: 0, cursor: "pointer",
              background: "#38bdf8", color: "#0f172a", fontWeight: 600, font: "inherit",
            }}>
            Recarregar
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErroFatal>
      <EditorAuditoria />
    </ErroFatal>
  </StrictMode>
);
