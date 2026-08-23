/**
 * @module bench/lib/servico
 * @description Sobe o servico sob medida, quando a pergunta E a configuracao.
 *
 * A BANCADA IRMA DO ebgeo_3d NAO SOBE SERVIDOR, e por um bom motivo: medir um
 * processo que ela mesma criou esconderia o efeito das variaveis de ambiente da
 * producao. Aqui a regra se INVERTE em dois casos, e so neles:
 *
 *   - `LOG_LEVEL` e lido na partida, por src/server.js. Comparar `info` com
 *     `warn` exige duas partidas. O `medir-web.js:863` sobe com `warn` e o
 *     `docker-compose.yml:15` fixa `info`, ou seja a medida de hoje descreve um
 *     servidor que ninguem opera.
 *   - `compress` com `global: true` esta escrito em src/server.js, sem chave de
 *     ambiente. Nao ha como pedir `false` de fora.
 *
 * DUAS MANEIRAS, e a diferenca entre elas importa na leitura do numero:
 *
 *   `subirReal` executa o `src/server.js` DE VERDADE, num processo filho, so
 *   trocando a variavel de ambiente. E a medida fiel, e serve ao LOG_LEVEL.
 *
 *   `subirEmbutido` monta um Fastify AQUI, com as rotas de tile e o compress
 *   parametrizado. Ele NAO e o servidor de producao: nao tem CORS, nem estatico,
 *   nem as outras rotas. Ele serve para medir o DELTA de um plugin sobre a mesma
 *   rota, e nunca para publicar um numero absoluto de vazao.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import { getIndexDb, closeAll } from '../../src/db/connection.js';
import { resetTileStatements } from '../../src/db/tiles-queries.js';
import photoTileRoutes from '../../src/routes/phototiles.js';
import healthRoutes from '../../src/routes/health.js';
import { esperarPorta } from '../../scripts/lib/cdp.js';

/**
 * O mesmo `customTypes` de src/server.js.
 *
 * COPIADO, e a copia e um risco declarado: se o server.js mudar o filtro, esta
 * linha passa a medir outra coisa em silencio. Ela existe porque o plugin nao
 * expoe a configuracao em tempo de execucao, e medir o delta exige as duas
 * pontas. Quem mexer la confira aqui.
 * @constant {RegExp}
 */
const TIPOS_COMPRIMIVEIS = /^(?:text\/|application\/(?:json|javascript|xml|vnd\.mapbox-vector-tile|.*\+json|.*\+xml))/;

/**
 * Sobe o `src/server.js` de verdade, num processo filho.
 *
 * @param {object} opcoes - Configuracao
 * @param {number} opcoes.porta - Porta a escutar
 * @param {string} opcoes.logLevel - Valor de LOG_LEVEL
 * @param {string} [opcoes.raiz] - Diretorio do repositorio
 * @returns {Promise<{fechar: Function, saida: Function}>} Controle do filho
 */
export async function subirReal({ porta, logLevel, raiz = process.cwd() }) {
  const filho = spawn(process.execPath, [resolve(raiz, 'src/server.js')], {
    env: { ...process.env, PORT: String(porta), LOG_LEVEL: logLevel },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let texto = '';
  filho.stdout.on('data', (d) => { texto += d; });
  filho.stderr.on('data', (d) => { texto += d; });

  try {
    await esperarPorta(`http://127.0.0.1:${porta}/health`, 60);
  } catch (err) {
    filho.kill();
    throw new Error(`o servico nao subiu em ${porta} com LOG_LEVEL=${logLevel}: ${err.message}\n${texto.slice(-2000)}`);
  }

  return {
    /** @returns {string} tudo que o filho escreveu ate agora */
    saida() { return texto; },
    /** Encerra o filho e espera ele sair. @returns {Promise<void>} */
    async fechar() {
      filho.kill();
      await new Promise((ok) => {
        const t = setTimeout(ok, 5000);
        filho.once('exit', () => { clearTimeout(t); ok(); });
      });
    },
  };
}

/**
 * Monta um Fastify aqui dentro, com o compress parametrizado.
 *
 * SO AS ROTAS DE TILE E O /health. O numero que sai daqui e comparavel COM ELE
 * MESMO, entre as duas variantes, e nunca com o `subirReal`.
 *
 * @param {object} opcoes - Configuracao
 * @param {number} opcoes.porta - Porta a escutar
 * @param {boolean} opcoes.compress - true para `global: true`, false para sem plugin
 * @returns {Promise<{fechar: Function}>} Controle do servidor
 */
export async function subirEmbutido({ porta, compress }) {
  const app = Fastify({ logger: false });
  if (compress) {
    await app.register(fastifyCompress, { global: true, customTypes: TIPOS_COMPRIMIVEIS });
  }
  getIndexDb();
  await app.register(healthRoutes);
  await app.register(photoTileRoutes);
  await app.listen({ port: porta, host: '127.0.0.1' });
  return {
    /** Fecha o servidor e os bancos que ele abriu. @returns {Promise<void>} */
    async fechar() {
      await app.close();
      resetTileStatements();
      closeAll();
    },
  };
}
