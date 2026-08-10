#!/usr/bin/env node

/**
 * @module scripts/derive-runs
 * @description Popula `capture_runs` e as colunas `run_id`/`run_position` de
 * `photos` a partir do identificador de sessao gravado no `original_name`.
 *
 * Uma faixa de coleta e uma SESSAO DE GRAVACAO — uma corrida continua do
 * veiculo. E a granularidade em que a calibracao e constante: medido no
 * faxinal, o desvio de mesh_rotation_y dentro da faixa e 0,60 grau contra 8,40
 * entre as medias das faixas. Ver scripts/lib/capture-runs.js para o porque de
 * a fronteira sair do id de sessao e nao de um corte por intervalo de tempo.
 *
 * O script e RE-EXECUTAVEL. Ele reconstroi as faixas de cada projeto do zero a
 * cada rodada, o que importa por dois motivos: `run_position` melhora sozinho
 * quando o `captured_at` for importado da fonte (o time_img), e fotos excluidas
 * por soft-delete precisam sair da contagem. O que ele NAO toca e a calibracao:
 * `applied_rotation_*` de uma faixa que ja existia e preservado pela chave
 * (project_id, session_key), entao re-derivar nao apaga o registro do default.
 *
 * Uso:
 *   node scripts/derive-runs.js [--data ./data] [--slug <slug>] [--dry-run]
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { groupPhotosIntoRuns } from './lib/capture-runs.js';

const args = process.argv.slice(2);
const getArg = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i === -1 || i + 1 >= args.length ? padrao : args[i + 1];
};
const dataDir = resolve(getArg('data', './data'));
const apenasSlug = getArg('slug', null);
const dryRun = args.includes('--dry-run');

const indexPath = resolve(dataDir, 'index.db');
if (!existsSync(indexPath)) {
  console.error(`index.db nao encontrado em ${indexPath}`);
  process.exit(1);
}

const db = new Database(indexPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// As colunas vem da migracao de startup do servico (src/db/connection.js).
// Rodar este script contra um banco que nunca subiu o servico falharia com um
// erro de SQL opaco; a checagem antecipa isso com uma instrucao acionavel.
const colunas = db.pragma('table_info(photos)').map(c => c.name);
const faltando = ['run_id', 'run_position', 'captured_at'].filter(c => !colunas.includes(c));
if (faltando.length) {
  console.error(`photos nao tem as colunas ${faltando.join(', ')}.`);
  console.error('Suba o servico uma vez (npm start) para aplicar a migracao, ou rode-a manualmente.');
  process.exit(1);
}

const projetos = apenasSlug
  ? db.prepare('SELECT id, slug FROM projects WHERE slug = ?').all(apenasSlug)
  : db.prepare('SELECT id, slug FROM projects ORDER BY slug').all();

if (!projetos.length) {
  console.error(apenasSlug ? `Projeto ${apenasSlug} nao encontrado.` : 'Nenhum projeto no banco.');
  process.exit(1);
}

// Fotos excluidas por soft-delete ficam de fora: elas nao aparecem em lugar
// nenhum da interface, e conta-las inflaria o photo_count da faixa e a barra
// de progresso da revisao.
const fotosDoProjeto = db.prepare(`
  SELECT ph.id, ph.original_name, ph.captured_at, ph.floor_level, ph.floor_label
  FROM photos ph
  WHERE ph.project_id = ?
    AND ph.id NOT IN (SELECT photo_id FROM deleted_photos)
`);

// Projeto COM andares declarados agrupa por andar, nao pelo nome do arquivo.
// A pergunta e feita ao banco, e nao a uma opcao de linha de comando, para o
// criterio nao depender de alguem lembrar da flag: a existencia de
// project_floors ja e a declaracao de que o projeto tem andares.
const andaresDoProjeto = db.prepare(
  'SELECT level, label FROM project_floors WHERE project_id = ?'
);

const faixaExistente = db.prepare(
  'SELECT id, applied_rotation_y, applied_rotation_x, applied_rotation_z FROM capture_runs WHERE project_id = ? AND session_key = ?'
);
const inserirFaixa = db.prepare(`
  INSERT INTO capture_runs
    (id, project_id, session_key, label, started_at, ordinal, photo_count,
     applied_rotation_y, applied_rotation_x, applied_rotation_z)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const apagarFaixasDoProjeto = db.prepare('DELETE FROM capture_runs WHERE project_id = ?');
const limparFotosDoProjeto = db.prepare(
  'UPDATE photos SET run_id = NULL, run_position = NULL WHERE project_id = ?'
);
const vincularFoto = db.prepare(
  'UPDATE photos SET run_id = ?, run_position = ? WHERE id = ?'
);

const relatorio = [];

const derivarProjeto = db.transaction((projeto) => {
  // O rotulo da faixa sai de project_floors, e nao do floor_label da foto: um
  // nivel pode reunir fotos com nomes diferentes (o nivel 0 do Beira-Rio tem
  // "Campo" e "Externo"), e a faixa e do ANDAR, nao de uma das partes dele.
  const rotuloDoNivel = new Map(
    andaresDoProjeto.all(projeto.id).map(a => [a.level, a.label])
  );
  const byFloor = rotuloDoNivel.size > 0;

  const fotos = fotosDoProjeto.all(projeto.id).map(r => ({
    id: r.id,
    originalName: r.original_name,
    capturedAt: r.captured_at,
    floorLevel: r.floor_level,
    floorLabel: rotuloDoNivel.get(r.floor_level) ?? r.floor_label,
  }));

  const { runs, unmatched } = groupPhotosIntoRuns(fotos, { byFloor });

  // Preserva o registro do default aplicado atravessando a reconstrucao: a
  // faixa e reidentificada pela session_key, que e estavel entre execucoes.
  const defaultsAnteriores = new Map();
  for (const faixa of runs) {
    const anterior = faixaExistente.get(projeto.id, faixa.sessionKey);
    if (anterior) {
      defaultsAnteriores.set(faixa.sessionKey, {
        y: anterior.applied_rotation_y,
        x: anterior.applied_rotation_x,
        z: anterior.applied_rotation_z,
      });
    }
  }

  if (!dryRun) {
    // Solta as referencias ANTES de apagar as faixas: photos.run_id aponta para
    // capture_runs, e o caminho inverso quebra a chave estrangeira na segunda
    // execucao (a primeira passa so porque run_id ainda esta todo NULL).
    limparFotosDoProjeto.run(projeto.id);
    apagarFaixasDoProjeto.run(projeto.id);

    for (const faixa of runs) {
      const id = randomUUID();
      const d = defaultsAnteriores.get(faixa.sessionKey) ?? { y: null, x: null, z: null };
      inserirFaixa.run(
        id, projeto.id, faixa.sessionKey, faixa.label, faixa.startedAt,
        faixa.ordinal, faixa.photoCount, d.y, d.x, d.z
      );
      faixa.photos.forEach((photoId, i) => vincularFoto.run(id, i + 1, photoId));
    }
  }

  const tamanhos = runs.map(r => r.photoCount).sort((a, b) => a - b);
  relatorio.push({
    projeto: projeto.slug,
    fotos: fotos.length,
    faixas: runs.length,
    ordem: byFloor
      ? 'andar'
      : (runs.length && runs.every(r => r.startedAt) ? 'cronologica' : 'tamanho'),
    menor: tamanhos[0] ?? 0,
    mediana: tamanhos[Math.floor(tamanhos.length / 2)] ?? 0,
    maior: tamanhos[tamanhos.length - 1] ?? 0,
    semFaixa: unmatched.length,
  });
});

console.log(`Derivando faixas de coleta em ${indexPath}${dryRun ? ' (dry-run)' : ''}\n`);
for (const projeto of projetos) {
  derivarProjeto(projeto);
}

console.table(relatorio);

const totalFotos = relatorio.reduce((a, r) => a + r.fotos, 0);
const totalFaixas = relatorio.reduce((a, r) => a + r.faixas, 0);
const totalSemFaixa = relatorio.reduce((a, r) => a + r.semFaixa, 0);
console.log(`\n${totalFaixas} faixas para ${totalFotos} fotos.`);
if (totalSemFaixa) {
  // Nao e fatal: a interface trata foto sem faixa como o modo antigo. Mas e o
  // sinal de que apareceu um padrao de nome novo, que merece uma regra em
  // scripts/lib/capture-runs.js em vez de ficar fora da navegacao por faixa.
  console.log(`ATENCAO: ${totalSemFaixa} foto(s) sem faixa — padrao de nome nao reconhecido.`);
} else {
  console.log('Todas as fotos foram atribuidas a uma faixa.');
}
if (dryRun) console.log('\nNada foi gravado (--dry-run).');

db.close();
