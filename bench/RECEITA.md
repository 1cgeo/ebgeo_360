# Receita das três bancadas

Esta pasta mede a pirâmide de tiles 360 em três camadas separadas. A separação é
o ponto: uma melhora de 20% no SQLite some dentro do ruído do HTTP, e um ganho na
rota some dentro do tempo de decodificação do navegador. Quem mistura as camadas
nunca sabe qual delas pagou a conta.

A bancada irmã vive no `ebgeo_3d`, em `bench/`. As duas usam a mesma forma de
argumento, a mesma forma de saída e a mesma disciplina de repetição.

## O que ficou de fora, e por quê

O acervo de produção já está inteiro processado em tiles, e a fórmula de geração
não muda. Então estes números **não se medem aqui**, e propor medi-los é gastar
rodada com decisão já paga:

`page_size`, `quality`, `effort`, `tile_size`, a razão da escada e a cascata de
resize.

O que sobra é código, e é só isso que as três bancadas atacam.

## O que cada bancada mede

| Arquivo | Comando | Camada | Responde |
| --- | --- | --- | --- |
| `banco.js` | `npm run bench` | SQLite direto | seek frio contra quente, a rajada inteira, `cache_size` e `mmap_size`, o `statSync` cobrado duas vezes por tile, o custo da margem |
| `http.js` | `npm run bench:http` | rota Fastify | a rajada de 54 com 24 em voo, `LOG_LEVEL` info contra warn, `compress` ligado contra desligado, o 304 e o ETag fraco, o trabalho por foto pago 54 vezes |
| `cliente.js` | `npm run bench:cliente` | navegador por CDP | primeiro quadro e nível alvo completo, passar `renderer` contra não passar, a serialização do `await` do nível 0 |

`lib/alvos.js` declara os alvos e monta a rajada. `lib/carga.js` traz o gerador
de carga HTTP e a estatística. `lib/servico.js` sobe o serviço quando a pergunta
é a própria configuração.

## Antes de rodar

1. A chave `STREETVIEW_DATA_DIR` aponta a raiz dos dados. Os três comandos leem o
   `.env` da raiz do repositório, e uma variável na linha de comando vence o
   arquivo.
2. O projeto precisa de pirâmide gerada. Sem `{slug}_tiles.db` as três saem com
   erro e dizem o que falta.
3. O `bench:cliente` exige o serviço no ar (`npm start`). O `bench:http` sobe os
   próprios servidores, e por isso não precisa de um de pé.

O projeto padrão é `faxinal`, e a escolha não é estética: o banco dele passa de
1 GiB contra os 256 MB de `mmap_size` do serviço. Num arquivo que cabe no mmap a
seção 4 do `banco.js` empata por construção, e foi exatamente o que a primeira
rodada desta bancada mediu num banco de 20,9 MiB.

## Os alvos

Eles vivem em `lib/alvos.js`, em um lugar só, e são fixos de propósito. Duas
execuções precisam pedir os mesmos tiles na mesma ordem, senão a comparação mede
o sorteio da câmera.

| Alvo | Viewport | Fov | Câmera |
| --- | --- | --- | --- |
| `visualizador` | 1888x890 | 75 | lon 0, lat 0 |
| `notebook` | 1350x673 | 75 | lon 0, lat 0 |
| `zenite` | 1888x890 | 75 | lon 90, lat 60 |
| `celular` | 412x915 | 75 | lon 180, lat 0 |
| `zoom` | 1888x890 | 30 | lon 270, lat -20 |

O primeiro é a referência, e ele traz o **canvas** de 1888x890, nunca a janela de
1904x985. O painel de calibração e a borda comem a diferença, e quem escolhe o
nível da pirâmide é o canvas.

## Os 54 tiles

`RAJADA_REFERENCIA` vale 54, e o número é **medido**, não calculado.
`tilesVisiveis` prevê 48 para a janela de 1904x985 e 60 para o canvas de
1888x890. O visualizador pediu 54, contados um a um pelo Network do CDP.

Nenhuma das duas contas acerta, porque o carregador desconta o que já desenhou e
a câmera não abre em lat 0 exata. A bancada mede 54 e imprime a previsão ao lado.
Medir 48 ou 60 mediria o instrumento.

## As três regras da medida

1. **Rodadas intercaladas.** Medir uma configuração inteira e depois a outra mede
   o cache de página do sistema esquentando.
2. **A melhor rodada, nunca a média.** A melhor é a que menos pagou interferência
   de fora.
3. **A régua sai da dispersão medida.** Metade da menor dispersão entre as duas
   medidas comparadas, com piso de 5%.

O `npm run bench` roda com `--expose-gc`. Sem o coletor sob controle, a coleta
cai no meio de uma rodada qualquer.

## Armadilhas que já mentiram nesta bancada

- **O primeiro canvas da página é o minimapa.** A página de calibração tem cinco
  canvas, e `querySelector('#viewer-container canvas')` devolve o do MapLibre, de
  339x277. O arrasto caiu nele: o mapa girou, a panorâmica não, e o giro fechou
  com zero tile enquanto o contador marcava 57 quadros por segundo. O canvas
  certo é o de maior área.
- **O laço de quadro tem que começar antes da carga.** Chamar
  `aplicarAtualizacoes` só depois do `await` de `carregarFoto` deixa os tiles
  chegarem sem nenhum quadro rodando. O A/B do `renderer` mediu o laço da bancada
  e chegou a dar o sinal trocado.
- **Uma foto por vez.** A página de calibração abre a foto pedida e depois busca
  vizinhas. Agrupar as ondas de rede por nível sem filtrar pelo uuid alvo mistura
  duas fotos, e o vão entre ondas sai negativo.
- **A leitura fria precisa de chaves novas.** Reler a mesma amostra na rodada
  seguinte mede o cache. Cada rodada fria usa uma fatia disjunta do arquivo, e a
  rajada fria troca de foto a cada repetição.
- **A conexão fria não é o disco frio.** O cache de página do sistema continua
  quente, e o processo não tem como esvaziá-lo. O número é o piso do custo frio.
- **`__sonda.pronto()` não serve aqui.** Ele procura `body.streetview-active` e
  `#street-view-container`, seletores do `ebgeo_web`. O que a sonda mede sem
  depender de seletor continua valendo.

## O que a bancada não alcança

- **Trocar `MARGEM_TILES`** exige editar `public/calibration/js/tile-loader.js`.
  O `banco.js` mede o custo da margem em tiles e em bytes; o benefício é visual e
  não está medido.
- **Latência de rede real.** Em localhost o `await` do nível 0 não chega a
  serializar, e a subida parcial do `renderer` sai pior que a inteira. Os dois
  resultados dependem de como os tiles se espalham no tempo, e a rede local os
  comprime.
- **O servidor embutido do `compress`** não é o de produção: ele monta só as
  rotas de tile. O número vale contra ele mesmo, entre as duas variantes.

## Argumentos

```
node --expose-gc bench/banco.js --projeto faxinal --chaves 4000 --rodadas 9
node bench/http.js --projeto faxinal --requisicoes 4000 --porta 8191 --json saida.json
node bench/cliente.js --projeto faxinal --repeticoes 3 --gpu hardware --json saida.json
```

O `--gpu software` troca a aceleração por SwiftShader. O `--base` aponta outro
endereço do serviço, e o padrão é `http://127.0.0.1:8081`.
