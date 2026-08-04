import { useState, forwardRef } from "react";
import { Eye, EyeOff } from "lucide-react";

// Campo de senha com o olho de mostrar/ocultar. Componente à parte porque são quatro deles
// (login e os três da troca de senha) e o comportamento tem que ser idêntico nos quatro.
// forwardRef: a tela de login põe o foco no campo pelo ref.
const CampoSenha = forwardRef(function CampoSenha({ label, className = "", ...props }, ref) {
  // cada campo abre e fecha por conta própria, e sempre nasce oculto
  const [visivel, setVisivel] = useState(false);
  return (
    <>
      {label && <label className="block text-xs text-[var(--muted)] mb-1">{label}</label>}
      <div className={"relative " + className}>
        <input ref={ref} type={visivel ? "text" : "password"} {...props}
          className="w-full pl-2.5 pr-9 py-2 rounded-lg border border-[var(--border)]
            bg-[var(--surface)] text-[var(--text)] focus:outline-none focus:border-[var(--accent)]" />
        {/* type="button": dentro de um <form>, o padrão seria submit e o clique enviaria a tela */}
        <button type="button" tabIndex={-1}
          onClick={() => setVisivel((v) => !v)}
          title={visivel ? "Ocultar senha" : "Mostrar senha"}
          aria-label={visivel ? "Ocultar senha" : "Mostrar senha"}
          className="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center
            justify-center rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hover)]">
          {visivel ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </>
  );
});

export default CampoSenha;
