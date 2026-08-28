#!/usr/bin/env node

/**
 * @module scripts/exportar-projeto
 * @description Exporta o RECORTE do index.db de um projeto, ou de todos, num
 * JSON por projeto.
 *
 * POR QUE EXISTE. O `{slug}_tiles.db` guarda o pixel e mais nada. Tudo que diz
 * ONDE cada foto esta, para onde ela aponta e o que liga uma a outra (posicao,
 * heading, os tres angulos de calibracao, os alvos, o tracado, as corridas e os
 * pisos) mora no `index.db` CENTRAL, que e um arquivo so para os 35 projetos.
 *
 * Isso torna o acervo de preservacao incompleto por construcao: o SAP 3.0
 * pendura todo arquivo numa versao de um produto (`acervo.arquivo.versao_id` e
 * NOT NULL), e um banco central nao tem produto onde morar. Sem este recorte, a
 * copia guardada seriam esferas sem orientacao, sem posicao e sem link, e
 * perder o index.db do servico bastaria para o acervo nao reconstruir nada.
 *
 * O `.3dtiles` do irmao ebgeo_3d ja resolve isso sozinho, pela tabela `meta`
 * que faz o arquivo se identificar fora do catalogo. Aqui o recorte faz o mesmo
 * papel, por fora.
 *
 * CUSTA POUCO: 235,5 MB para os 35 projetos, contra 122 GiB de tiles.
 *
 * FOTO APAGADA NAO ENTRA em `fotos`, e o id dela vai para `apagadas`. E o mesmo
 * cuidado que faltou ao `generate-pmtiles.js`, que nao filtra o soft-delete e
 * vazava no tile uma foto que `/photos/:uuid` responde com 404. O registro da
 * exclusao fica, porque some-la sem deixar rastro e outra forma de mentir.
 *
 * Uso:
 *   node scripts/exportar-projeto.js                  # todos os projetos
 *   node scripts/exportar-projeto.js museu_cms
 *   node scripts/exportar-projeto.js --destino /caminho
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import config from '../src/config.js';
import { getIndexDb, closeAll } from '../src/db/connection.js';

const ESQUEMA = 1;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    destino: { type: 'string', default: '' },
  },
});

const destino = values.destino
  ? resolve(values.destino)
  : join(config.dataDir, 'projects');

if (!existsSync(destino)) mkdirSync(destino, { recursive: true });

const db = getIndexDb();

const projetos = positionals.length
  ? positionals.map((slug) => {
    const p = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
    if (!p) {
      console.error(`AUSENTE no index: ${slug}`);
      process.exitCode = 1;
    }
    return p;
  }).filter(Boolean)
  : db.prepare('SELECT * FROM projects ORDER BY slug').all();

const apagadas = new Set(
  db.prepare('SELECT photo_id FROM deleted_photos').all().map((r) => r.photo_id)
);

let total = 0;
for (const projeto of projetos) {
  const todas = db.prepare('SELECT * FROM photos WHERE project_id = ? ORDER BY sequence_number').all(projeto.id);
  const fotos = todas.filter((f) => !apagadas.has(f.id));
  const idsApagadas = todas.filter((f) => apagadas.has(f.id)).map((f) => f.id);

  // Os alvos saem em lotes: uma clausula IN com 17 mil parametros estoura o
  // limite de variaveis do SQLite (SQLITE_MAX_VARIABLE_NUMBER).
  const alvos = [];
  const LOTE = 500;
  const consulta = new Map();
  for (let i = 0; i < fotos.length; i += LOTE) {
    const pedaco = fotos.slice(i, i + LOTE).map((f) => f.id);
    let stmt = consulta.get(pedaco.length);
    if (!stmt) {
      stmt = db.prepare(`SELECT * FROM targets WHERE source_id IN (${pedaco.map(() => '?').join(',')})`);
      consulta.set(pedaco.length, stmt);
    }
    alvos.push(...stmt.all(...pedaco));
  }

  const recorte = {
    schemaVersion: ESQUEMA,
    geradoEm: new Date().toISOString(),
    origem: 'index.db',
    projeto,
    fotos,
    alvos,
    tracados: db.prepare('SELECT * FROM project_tracks WHERE project_id = ?').all(projeto.id),
    corridas: db.prepare('SELECT * FROM capture_runs WHERE project_id = ? ORDER BY ordinal').all(projeto.id),
    pisos: db.prepare('SELECT * FROM project_floors WHERE project_id = ?').all(projeto.id),
    apagadas: idsApagadas,
    totais: {
      fotos: fotos.length,
      alvos: alvos.length,
      apagadas: idsApagadas.length,
      // O `photo_count` do catalogo entra AO LADO da contagem medida, e nao no
      // lugar dela. Ele nao e mantido de um jeito so: em museu_cms conta as 77
      // linhas de `photos` (a apagada inclusa) e em serra_dourada conta as 147
      // vivas de 150 linhas. Guardar os dois deixa a divergencia visivel em vez
      // de escolher um lado em silencio.
      photo_count_do_catalogo: projeto.photo_count,
    },
  };

  const caminho = join(destino, `${projeto.slug}_metadados.json`);
  const texto = JSON.stringify(recorte);
  writeFileSync(caminho, texto);
  total += texto.length;

  // So avisa quando o catalogo nao bate com NENHUMA das duas leituras: nem com
  // as fotos vivas, nem com o total de linhas. Ai o numero nao vem de contagem
  // nenhuma, e e defeito de verdade.
  const bate = projeto.photo_count === fotos.length
    || projeto.photo_count === fotos.length + idsApagadas.length;
  const aviso = bate ? '' : '  [photo_count DIVERGE das duas leituras]';
  console.log(
    `${projeto.slug.padEnd(24)} ${String(fotos.length).padStart(6)} fotos  ${String(alvos.length).padStart(7)} alvos  ` +
    `${(texto.length / 1048576).toFixed(2).padStart(7)} MB${aviso}`
  );
}

console.log(`\n${projetos.length} projeto(s), ${(total / 1048576).toFixed(1)} MB em ${destino}`);
closeAll();
