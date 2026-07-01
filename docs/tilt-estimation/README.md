# Estimativa automática de pitch/roll (mesh_rotation_x / mesh_rotation_z) — WIP

Objetivo: estimar automaticamente `mesh_rotation_x` (pitch) e `mesh_rotation_z` (roll)
das fotos 360, começando pelo projeto **santa_cruz** (471 fotos). Documento de estado
para retomar depois. Contexto da importação do lote: ver memória `migracao-lote-360-2026`.

## Estado atual (2026-07-01)
- **`mesh_rotation_y = 330` já aplicado a todo o santa_cruz** (usuário confirmou visualmente; a fonte trazia 60). Uniforme no projeto.
- **roll ≈ constante ~1°** (veículo praticamente não "rola"); **pitch** é o que varia (pequeno, < ~10°).
- Tentativa por IMU: **descartada**. Tentativa por visão computacional (CV): **em andamento** (v1 falhou por causa de árvores; v2 planejada).

## Gabarito (medido pelo usuário na UI de calibração)
| display_name | uuid | pitch (mesh_rotation_x) | roll (mesh_rotation_z) |
|---|---|---|---|
| Santa_Cruz_0350 | e1729ee0-ed3f-4b42-94d8-5229a81c90e0 | 9,2 | 1,0 |
| Santa_Cruz_0453 | 61ffbeed-b109-453c-9a84-40065ff4d99d | 4,2 | 1,3 |
| Santa_Cruz_0086 | d0733d73-4d8f-4b46-8051-d70b4cefe259 | ~nível (controle) | ~nível |

Usar esses pontos para **calibrar fase/sinal** da conversão (some o acoplamento do yaw=330).

## Convenções do viewer (public/calibration/js/viewer.js)
- `sphere.rotation.order = 'ZXY'` → matriz `Rz·Rx·Ry` (Y aplicado primeiro aos pixels, depois X, depois Z).
- `rotation.z` = roll = `mesh_rotation_z`; `rotation.x` = pitch = `mesh_rotation_x`; `rotation.y` = `mesh_rotation_y` = **330**. Graus positivos, convertidos com `THREE.MathUtils.degToRad`.
- Como Rx/Rz são aplicados **depois** de Ry(330), a decomposição pitch/roll ocorre no frame pós-yaw → há acoplamento de 330° a resolver empiricamente com o gabarito.

## Tentativa 1 — IMU (acelerômetro). DESCARTADA
- IMU (`ax/ay/az/gx/gy/gz`) **não está no `index.db`**; está em `data/_source_backup/santa_cruz_metadata.json`.
- É câmera **MULTICAPTURA em movimento** → acelerômetro = gravidade + aceleração linear (curvas/freadas/buracos).
- `|a|` varia 0,49–2,19; só 52% em [0,9;1,1]. `|a|≈1` **não** garante repouso (aceleração lateral perpendicular mantém a magnitude ~1g mas envenena a direção).
- Mediana móvel (±7) não recupera: p/ 0350 a gravidade suavizada implica **30°** de tilt, mas o real é **~9°**. Ajuste aos 2 gabaritos deu **erro ~48°** → sem transformação que case.
- Script de referência: `estimate-tilt.mjs` (lê do HD, hoje desconectado; adaptar para `data/_source_backup/*.json`).

## Tentativa 2 — Visão computacional (horizonte → senoide). EM ANDAMENTO
Geometria: numa equirretangular, o horizonte de uma câmera inclinada é uma senoide
`lat(θ) = c0 + A·cosθ + B·sinθ`. Tilt `τ = √(A²+B²)` (px→graus por `180/H`), azimute `α = atan2(B,A)`.
Decompor `(τ,α)` em pitch/roll (fase/sinal calibrados com o gabarito).

### v1 (`cv-horizon.mjs`) — FALHOU (por árvores)
Detector "claro acima / escuro abaixo" trava na borda **céu/copa-de-árvore**, não no horizonte real:
- 0350: senoide falsa de **34°** (real ~9°); `c0` derivou para −23° (média do horizonte fora do equador = erro claro).
- 0453: só 8% inliers (céu nublado uniforme).
- 0086: ok-ish (8°, real ~0).
Overlays gerados: `sc0350_horizon.png`, `sc0453_horizon.png`, `sc0086_horizon.png` (scratchpad da sessão).

### v2 (a implementar) — corrige o que a v1 mostrou
1. **Segmentar céu por cor** (claro + baixa saturação) em vez de cinza — separa o céu branco/nublado.
2. **Fixar `c0 = H/2`** — para tilt puro a média do horizonte é o equador; remove a deriva.
3. **Ajuste por envelope inferior** — o horizonte real fica *abaixo* da copa; ajustar só (A,B) rejeitando topos de árvore (outliers acima).
4. **Confiança por foto** (fração de colunas com céu-aberto→solo limpo) → **auto-aplicar** nas confiáveis (campo aberto, maioria) e **marcar** as arborizadas para ajuste manual rápido.
5. **Calibrar** (A,B)→(pitch,roll) com o gabarito (0350=9.2/1, 0453=4.2/1.3) — fixa sinal e o offset do yaw 330.

## Como retomar (fontes de dados)
- **Metadados/IMU:** `data/_source_backup/{slug}_metadata.json` (JSONs completos dos 18.335 fotos).
- **Imagens:** extrair `full_webp` de `data/projects/santa_cruz.db` por `photo_id` (=uuid). Ex.:
  ```js
  const db = new Database('data/projects/santa_cruz.db', { readonly: true });
  const { full_webp } = db.prepare('SELECT full_webp FROM images WHERE photo_id=?').get(uuid);
  // full_webp é o Buffer WebP → sharp(full_webp)...
  ```
- **uuid por display_name:** `SELECT p.id FROM photos p JOIN projects pr ON pr.id=p.project_id WHERE pr.slug='santa_cruz' AND p.display_name=?`.
- **Aplicar resultado:** loop em `PUT /api/v1/photos/:uuid/rotation-x` e `.../rotation-z` (server em `./data`, recomendado por ser reversível), ou `UPDATE photos SET mesh_rotation_x=?, mesh_rotation_z=? WHERE id=?` no `index.db` (parar o server antes).

## Arquivos nesta pasta
- `cv-horizon.mjs` — protótipo CV v1 (base para a v2). Ajustar caminhos; imagens agora vêm do `{slug}.db`, não do HD.
- `estimate-tilt.mjs` — análise IMU (abandonada; referência de por que não funciona no rig em movimento).
