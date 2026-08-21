// ---- arrastar para reordenar uma lista ----
//
// Usado na fila de documentos e na janela de juntar partes. Uma cópia só da mecânica, para os
// dois lugares se comportarem igual.
//
// O problema difícil aqui é o toque. A fila é uma lista que rola — no celular ela é a gaveta
// inteira — então não dá para pôr touch-action: none nos cards, que é o que as caixas de
// anotação fazem: mataria a rolagem com o dedo, que é como se anda numa fila de 50 PDFs.
//
// A saída é o toque longo. O card fica com touch-action: pan-y, então o dedo rola como sempre;
// se o navegador assumir o gesto como rolagem ele nos manda pointercancel, e é esse evento —
// e não um palpite sobre distância — que diz "isto era rolagem, desarma". Passados 350 ms com o
// dedo parado, ninguém está rolando: aí sim o arrasto começa.
//
// No mouse não há essa disputa, então basta um limiar de movimento para o clique que abre o
// documento continuar sendo um clique.
import { useRef, useState, useEffect, useLayoutEffect, useReducer } from "react";

const ESPERA_TOQUE = 350;   // ms parado até o toque virar arrasto
const FOLGA_TOQUE = 10;     // px de tolerância antes disso (o dedo nunca fica imóvel)
const LIMIAR_MOUSE = 5;     // px de movimento que separam clique de arrasto
const BORDA_ROLAGEM = 40;   // px do topo/fim do container onde a rolagem automática liga
const PASSO_ROLAGEM = 8;    // px por quadro
const DESLIZE = 160;        // ms do deslize dos vizinhos ao trocar de lugar
const ENCAIXE = 140;        // ms do card voltando ao lugar quando solta

const semMovimento = () => typeof matchMedia === "function"
  && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Move o item UM passo na direção do ponteiro, ou devolve null se não é hora de mexer.
//
// Um passo por vez, e comparando com o MEIO do vizinho, é o que evita o tremor quando os itens
// têm alturas diferentes — e têm: o card da fila só mostra a linha "por Fulano · data" quando o
// PDF já foi auditado. Trocar assim que o ponteiro encosta no vizinho faria o item ir e voltar
// sem parar na fronteira.
//
// Separada do hook para poder ser exercitada sem navegador: `caixaDe(id)` devolve o retângulo
// do item, que no app vem de getBoundingClientRect e no teste vem de números à mão.
export const passoDeReordem = ({ ordem, id, y, caixaDe }) => {
  const i = ordem.indexOf(id);
  if (i < 0) return null;
  const eu = caixaDe(id);
  if (!eu) return null;
  // só se o ponteiro saiu do próprio item — dentro dele não há o que decidir
  const alvo = y < eu.top ? i - 1 : y > eu.bottom ? i + 1 : -1;
  if (alvo < 0 || alvo >= ordem.length) return null;
  const r = caixaDe(ordem[alvo]);
  if (!r) return null;
  const meio = r.top + r.height / 2;
  // subindo, só troca depois de passar do meio do de cima; descendo, do meio do de baixo
  if ((alvo < i && y > meio) || (alvo > i && y < meio)) return null;
  const nova = [...ordem];
  nova.splice(alvo, 0, nova.splice(i, 1)[0]);
  return nova;
};

// Retângulo da VAGA do item, e não o de onde ele está sendo visto.
//
// O card arrastado segue o ponteiro por transform, então o getBoundingClientRect dele anda
// junto — e aí o ponteiro nunca "sairia" do próprio item, que é a pergunta que passoDeReordem
// faz. Descontar o deslocamento devolve o buraco que ele deixou na lista, que é o que importa.
export const caixaVaga = (cont, id, s) => {
  const el = cont.querySelector(`[data-arrasto-id="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const dy = s && String(s.id) === String(id) ? (s.dy || 0) : 0;
  if (!dy) return r;
  return { top: r.top - dy, bottom: r.bottom - dy, height: r.height };
};

// `ids` é a ordem atual; `aoSoltar(novaOrdem)` recebe a ordem final, uma vez, no fim do gesto.
// `containerRef` é o elemento que rola — usado para a rolagem automática e para travar o toque
// enquanto o arrasto durar.
export const useArrastarLista = ({ ids, aoSoltar, containerRef, desligado }) => {
  const [arrastandoId, setArrastandoId] = useState(null);
  // a ordem de trabalho vive em ref; este contador é o que pede o redesenho a cada passo.
  // setArrastandoId(mesmo id) não serviria: o React descarta a atualização de valor igual.
  const [, redesenhar] = useReducer((x) => x + 1, 0);
  // tudo o que muda a cada pointermove vive em ref: re-renderizar a lista a cada pixel é o que
  // o resto do editor evita com o mesmo cuidado (ver o comentário do store)
  const st = useRef(null);
  const ordemRef = useRef(ids);
  ordemRef.current = arrastandoId ? ordemRef.current : ids;
  const rolagem = useRef(0);
  // fica ligado do fim do arrasto até o clique seguinte: sem isto, soltar o card dispara o
  // onClick que abre o documento
  const engolirClique = useRef(false);
  // retrato dos `top` de antes da troca, para o useLayoutEffect saber de onde deslizar
  const antesDaTroca = useRef(null);

  const pararRolagem = () => {
    if (rolagem.current) { cancelAnimationFrame(rolagem.current); rolagem.current = 0; }
  };

  const itens = () => {
    const cont = containerRef && containerRef.current;
    return cont ? [...cont.querySelectorAll("[data-arrasto-id]")] : [];
  };

  // ---- o card levantado, escrito direto no DOM ----
  // Sem passar pelo React: a fila mora dentro do componente que também segura o PDF na tela, e
  // um render por pixel de arrasto é o custo que o resto do editor evita de propósito (a pinça
  // faz igual, escrevendo transform no wrapRef).
  const levantar = (el) => {
    // recomeçar o arrasto dentro do encaixe do anterior: a limpeza pendente apagaria os
    // estilos deste gesto no meio do caminho
    if (el._limpezaArrasto) { clearTimeout(el._limpezaArrasto); el._limpezaArrasto = 0; }
    el.style.position = "relative";
    el.style.zIndex = "5";
    el.style.boxShadow = "0 10px 24px rgba(0,0,0,.28)";
    el.style.transition = "none";
    el.style.willChange = "transform";
  };
  const seguirPonteiro = (el, dy) => {
    el.style.transform = `translateY(${dy}px) scale(1.02)`;
  };
  const pousar = (el) => {
    // volta ao lugar em vez de sumir de repente; a limpeza vem depois da transição
    el.style.transition = semMovimento() ? "none" : `transform ${ENCAIXE}ms ease-out`;
    el.style.transform = "";
    const limpar = () => {
      el._limpezaArrasto = 0;
      el.style.position = ""; el.style.zIndex = ""; el.style.boxShadow = "";
      el.style.transition = ""; el.style.willChange = ""; el.style.transform = "";
    };
    if (semMovimento()) limpar();
    else el._limpezaArrasto = setTimeout(limpar, ENCAIXE + 20);
  };

  const encerrar = (soltou) => {
    const s = st.current;
    st.current = null;
    pararRolagem();
    if (!s) return;
    escutarJanela(s, false);
    clearTimeout(s.timer);
    const cont = containerRef && containerRef.current;
    if (cont) { cont.style.touchAction = ""; cont.classList.remove("arrastando"); }
    document.body.style.cursor = "";
    if (s.ativo) {
      // solto ou cancelado, o card levantado tem que voltar ao normal — senão fica com
      // transform e sombra grudados para sempre
      pousar(s.alvo);
      engolirClique.current = true;
      setArrastandoId(null);
      if (soltou && aoSoltar) aoSoltar(ordemRef.current);
    }
  };

  // Desmontar no meio de um gesto não pode deixar nada agendado. O toque longo é o caso
  // real: a janela de juntar fecha por Esc, por clique no fundo e pelo caminho de erro, tudo
  // isso alcançável dentro dos 350 ms — e o timer sobrevivente iria mexer num nó já solto.
  useEffect(() => () => {
    pararRolagem();
    if (st.current) {
      escutarJanela(st.current, false);
      clearTimeout(st.current.timer);
      st.current = null;
    }
    const cont = containerRef && containerRef.current;
    if (cont) { cont.style.touchAction = ""; cont.classList.remove("arrastando"); }
    document.body.style.cursor = ""; // desmontar no meio do gesto não pode deixar a mão fechada
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- o deslize dos vizinhos (FLIP) ----
  // Não dá para animar mudança de ordem no DOM: mede-se antes, deixa o React reordenar, e
  // anima-se do lugar antigo para o novo. Roda depois do render e antes da pintura.
  useLayoutEffect(() => {
    const antes = antesDaTroca.current;
    antesDaTroca.current = null;
    if (!antes || semMovimento()) return;
    const mexidos = [];
    for (const el of itens()) {
      const id = el.getAttribute("data-arrasto-id");
      // o arrastado já é comandado pelo ponteiro; animar os dois brigaria
      if (!antes.has(id) || (st.current && String(st.current.id) === id)) continue;
      const delta = antes.get(id) - el.getBoundingClientRect().top;
      if (!delta) continue;
      el.style.transition = "none";
      el.style.transform = `translateY(${delta}px)`;
      mexidos.push(el);
    }
    if (!mexidos.length) return;
    const quadro = requestAnimationFrame(() => {
      for (const el of mexidos) {
        el.style.transition = `transform ${DESLIZE}ms ease-out`;
        el.style.transform = "";
      }
    });
    return () => cancelAnimationFrame(quadro);
  });

  const reordenar = (y) => {
    const cont = containerRef && containerRef.current;
    if (!cont) return;
    const s = st.current;
    if (!s) return; // o gesto acabou entre o quadro agendado e esta chamada
    const nova = passoDeReordem({
      ordem: ordemRef.current, id: s.id, y,
      caixaDe: (id) => caixaVaga(cont, id, s),
    });
    if (!nova) return;
    // o retrato tem que sair AQUI: já se sabe que vai mexer, e o DOM ainda está no
    // arranjo antigo. Tirá-lo antes da decisão custaria uma medição por quadro à toa
    // durante a rolagem automática.
    antesDaTroca.current = new Map(
      itens().map((el) => [el.getAttribute("data-arrasto-id"), el.getBoundingClientRect().top]));
    ordemRef.current = nova;
    redesenhar();
  };

  // sem isto não dá para arrastar o último de uma fila longa até o começo
  const rolarSePreciso = (y) => {
    const cont = containerRef && containerRef.current;
    if (!cont) return;
    const r = cont.getBoundingClientRect();
    const dir = y < r.top + BORDA_ROLAGEM ? -1 : y > r.bottom - BORDA_ROLAGEM ? 1 : 0;
    if (!dir) return pararRolagem();
    if (rolagem.current) return;
    const passo = () => {
      if (!st.current || !st.current.ativo) return pararRolagem();
      cont.scrollTop += dir * PASSO_ROLAGEM;
      reordenar(st.current.y);
      rolagem.current = requestAnimationFrame(passo);
    };
    rolagem.current = requestAnimationFrame(passo);
  };

  const ativar = (e) => {
    const s = st.current;
    if (!s || s.ativo) return;
    s.ativo = true;
    // âncora no momento da ativação, e não no pointerdown: no toque longo o dedo derrapa
    // alguns pixels durante os 350 ms, e ancorar lá faria o card nascer já deslocado
    s.yAncora = e ? e.clientY : s.y;
    s.dy = 0;
    try { s.alvo.setPointerCapture(s.pointerId); } catch { /* ponteiro já foi embora */ }
    const cont = containerRef && containerRef.current;
    if (cont) {
      cont.style.touchAction = "none"; // agora o dedo arrasta, não rola
      cont.classList.add("arrastando"); // desliga o hover que mexe em transform
    }
    // a mão fechada vale para a página toda: o gesto é escutado na janela, então o ponteiro
    // sai de cima do card o tempo todo — e sem isto o cursor voltaria ao normal no meio do
    // arrasto, como se ele tivesse acabado
    document.body.style.cursor = "grabbing";
    levantar(s.alvo);
    setArrastandoId(s.id);
    if (e) reordenar(e.clientY);
  };

  // Os handlers do gesto ficam na JANELA, e não em cada card.
  //
  // Presos ao card, o encerramento dependia de o ponteiro estar por cima de algum — e não
  // está: na fila lateral quase toda a área abaixo dos documentos é container vazio, e soltar
  // o botão ali não entregava o pointerup a ninguém. A captura de ponteiro também não salva,
  // porque ela cai na PRIMEIRA troca de posição: o React reordena movendo o nó, mover é sair e
  // voltar ao documento, e sair do documento libera a captura.
  //
  // As identidades vão guardadas no próprio estado do gesto: um redesenho no meio do arrasto
  // recria as funções, e remover a identidade nova deixaria a antiga escutando para sempre.
  const escutarJanela = (s, ligar) => {
    if (!s || !s.handlers) return;
    const f = ligar ? window.addEventListener : window.removeEventListener;
    f.call(window, "pointermove", s.handlers.move);
    f.call(window, "pointerup", s.handlers.up);
    f.call(window, "pointercancel", s.handlers.cancel);
  };

  const onPointerDown = (id) => (e) => {
    if (desligado || e.button > 0) return;
    // um segundo dedo no meio do arrasto trocaria o st.current por um gesto novo e inativo:
    // o pointerup seguinte cairia no ramo "não estava arrastando", e aí o card ficaria com
    // os estilos de arrasto grudados, a reordenação seria descartada e a lista continuaria
    // presa na ordem de trabalho, porque o arrastandoId nunca voltaria a null
    if (st.current) return;
    // a caixinha de seleção e a lixeira são alvos próprios: um toque neles não é arrasto
    if (e.target.closest && e.target.closest("button, input, a")) return;
    engolirClique.current = false;
    st.current = {
      id, pointerId: e.pointerId, alvo: e.currentTarget,
      x0: e.clientX, y0: e.clientY,  // origem do gesto, para medir o quanto andou
      y: e.clientY,                  // último Y, que a rolagem automática reaproveita
      ativo: false, timer: 0,
      handlers: { move: onPointerMove, up: onPointerUp, cancel: onPointerCancel },
    };
    escutarJanela(st.current, true);
    ordemRef.current = ids;
    if (e.pointerType !== "mouse") {
      // toque longo: 350 ms parado. Se o navegador começar a rolar antes, o pointercancel
      // desarma; se o dedo andar demais, o pointermove desarma.
      st.current.timer = setTimeout(() => ativar(null), ESPERA_TOQUE);
    }
  };

  const onPointerMove = (e) => {
    const s = st.current;
    if (!s || e.pointerId !== s.pointerId) return; // evento de outro dedo

    // a distância sai da ORIGEM do gesto, antes de atualizar o último Y
    const dist = Math.hypot(e.clientX - s.x0, e.clientY - s.y0);
    s.y = e.clientY;
    // soltar o botão fora da janela do navegador pode não gerar pointerup nenhum; sem esta
    // rede o gesto ficaria vivo e o card voltaria a arrastar no movimento seguinte
    if (s.ativo && e.pointerType === "mouse" && e.buttons === 0) return encerrar(true);
    if (!s.ativo) {
      if (e.pointerType === "mouse") { if (dist > LIMIAR_MOUSE) ativar(e); return; }
      // o dedo andou antes dos 350 ms: é rolagem, não arrasto
      if (dist > FOLGA_TOQUE) { clearTimeout(s.timer); st.current = null; }
      return;
    }
    // o card acompanha o ponteiro, preso à área visível da lista para não escapar dela
    const cont = containerRef && containerRef.current;
    let dy = e.clientY - s.yAncora;
    if (cont) {
      const rc = cont.getBoundingClientRect();
      const eu = s.alvo.getBoundingClientRect();
      // eu já vem com o transform aplicado; tirando o dy anterior sobra a posição da vaga
      const vagaTopo = eu.top - s.dy, vagaFim = eu.bottom - s.dy;
      dy = Math.min(Math.max(dy, rc.top - vagaTopo), rc.bottom - vagaFim);
    }
    s.dy = dy;
    seguirPonteiro(s.alvo, dy);
    reordenar(e.clientY);
    rolarSePreciso(e.clientY);
  };

  // só o dedo que começou o gesto pode terminá-lo
  const doGesto = (e) => st.current && e.pointerId === st.current.pointerId;
  const onPointerUp = (e) => { if (doGesto(e)) encerrar(true); };
  const onPointerCancel = (e) => { // o navegador assumiu o gesto: era rolagem
    if (doGesto(e)) encerrar(false);
  };

  return {
    arrastandoId,
    // o clique de abrir o documento consulta isto antes de agir
    engoliuClique: () => {
      if (!engolirClique.current) return false;
      engolirClique.current = false;
      return true;
    },
    // a ordem a desenhar: durante o arrasto é a de trabalho, fora dele é a de quem chama
    ordem: arrastandoId ? ordemRef.current : ids,
    // só o pointerdown mora no card; o resto do gesto é escutado na janela (ver escutarJanela)
    props: (id) => ({
      "data-arrasto-id": id,
      onPointerDown: onPointerDown(id),
      // pan-y: o dedo continua rolando a lista. Só depois do toque longo o container trava.
      style: { touchAction: "pan-y" },
    }),
  };
};
