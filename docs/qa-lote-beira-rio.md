# Conferência do lote Beira-Rio

Pasta `MISSAO_BEIRA_RIO`. Revisão de 2026-08-05, sobre a entrega de 350 fotos,
894 ligações e 189 linhas de planta. A conferência anterior é de 2026-08-04, com
348 fotos.

Mudaram 4 arquivos: os json de `PIC_20260520_153807_20260521163901` e
`PIC_20260520_153904_20260521163901`, mais `fotos.geojson` e
`fotos_linha.geojson`. Os outros 348 json seguem intactos.

**Corrigidos:** os itens 2, 3 e 4. Zero alvos mortos, zero pontos sem foto, zero
nomes duplicados. O `fotos.geojson` passou de 357 features para 350, todos com
foto entregue e nome único.

| # | defeito | estado |
|---|---|---|
| 16 | O lote não entrega o rumo de cada foto | novo, bloqueia |
| 1 | O andar 6 é uma ilha no grafo | aberto, bloqueia |
| 13 | 22 fotos com `heading` igual a 0 exato | novo, alto |
| 14 | As 2 fotos novas não têm `locate` | novo, alto |
| 15 | As 2 fotos novas não têm nenhum `next` | novo, médio |
| 5 | A cadeia `next` não fecha | aberto |
| 6 | O `ele` é zero em 207 de 350 | aberto |
| 7 | O `initialYaw` é ruído | aberto |
| 8 | O `mesh_rotation_y` é constante e ninguém o aplica | aberto |
| 9 | O `fotos_linha.geojson` são tocos de 2 vértices | aberto |
| 10 | 42 pastas de `dados_brutos` sem foto entregue | aberto |
| 11 | 4,1 GB de `_original.jpg` na mesma dimensão do entregue | aberto |
| 12 | `cameraHeight` no padrão de fábrica em 70 fotos | aberto |

## 16. O lote não entrega o rumo de cada foto

O equipamento é um Insta360 Pro2 em tripé, apoiado a cada disparo na direção
que der. O centro do panorama é a lente da frente, então **cada foto aponta para
um lado diferente**. Nenhum campo entregue registra qual.

Conferido campo a campo:

| campo | o que é | serve de rumo? |
|---|---|---|
| `mesh_rotation_y` | 60 em todas as 350 | não, é constante |
| `textureRotation` | 0 em todas as 350 | não, o controle nunca foi usado |
| `initialYaw` | onde o mouse parou | não, R de 0,137 contra o `heading` |
| `heading` | azimute para a próxima foto | não, é rumo de marcha |
| `pro.prj` | só `gravity_x/y/z`, igual nos dois arquivos conferidos | dá inclinação, não rumo |
| EXIF | sem `GPSImgDirection` | não |

O `heading` merece nota. Ele é o azimute geométrico para o alvo `next`, com
erro de 4,60° na mediana e 222 de 285 abaixo de 10°. Ou seja, é a direção da
caminhada, não a direção para onde a imagem aponta.

Na prática: aplicando o `mesh_rotation_y` do metadado, uma foto sai certa e a
seguinte sai cerca de 220° fora. Não é defeito de fórmula, é ausência de dado.

**Corrigir, do mais barato ao mais caro:**

1. **Enviar os JSON originais da ferramenta de calibração**, os que ela grava
   com `customX`, `customY` e `customZ` por marcador. O operador posicionou cada
   marcador à mão, olhando a imagem, então essas coordenadas dizem em que
   direção da IMAGEM está cada alvo. Cruzando com o azimute real, que sai de
   lat/lon, o rumo de cada foto se resolve por conta. Um marcador já basta, dois
   ou mais deixam conferir. Os arquivos existem na máquina que rodou a
   ferramenta, e não vieram na entrega.
2. Calibrar o rumo à mão nas 350, na interface de calibração.
3. Integrar o `gyro.mp4` de cada disparo. Dá rumo relativo, não absoluto, então
   ainda exige uma referência manual por sessão.

**Teste.** Duas fotos vizinhas, com a mesma configuração aplicada, têm de
mostrar o marcador do alvo `next` na direção do corredor em ambas.

## 1. O andar 6 é uma ilha no grafo

Sem mudança. O grafo se parte em 332 fotos mais 18, e as 18 são o andar 6
inteiro. Nenhuma ligação sai dele.

As 84 ligações que cruzam andar são: `andar 1 <-> andar 2` 34, `andar 1 <-> área
externa` 30, `andar 1 <-> campo` 8, `andar 5 <-> área externa` 8, `andar 2 <->
andar 3` 2, `andar 3 <-> andar 4` 2. O andar 6 não aparece.

A foto do andar 6 mais próxima de outro andar está a 1,5 m do `andar 3`.

**Corrigir.** Ligar o andar 6 na foto do patamar da escada, nos dois sentidos.
**Teste.** Um componente só, com 350 fotos.

## 13. Vinte e duas fotos com `heading` igual a 0 exato

Achado novo. Não estava na conferência anterior.

Os outros 328 valores de `heading` têm 3 casas decimais e 326 são distintos
(19,455; 238,719; 231,298). Um zero exato no meio disso não é medida, é campo
não preenchido.

As 22 são todas do dia 2026-05-20: 18 no `andar 1`, 3 no `andar 3`, 1 no
`andar 4`. Só 1 foto do lote inteiro cai perto de zero sem ser zero.

Sem `heading`, o marcador de navegação não tem para onde apontar.

**Corrigir.** Medir o rumo dessas 22, ou entregar o campo nulo.
**Teste.** Nenhum `heading` igual a 0 exato.

## 14. As 2 fotos novas não têm `locate`

`PIC_20260520_153807_20260521163901` e `PIC_20260520_153904_20260521163901` são
as únicas 2 de 350 sem o campo `locate`. O andar delas só existe no
`fotos.geojson`, que diz `andar 1` nas duas.

O `locate` é a única fonte de andar dentro do json. Sem ele, a foto não tem
andar para quem lê só o metadado.

Elas também não têm o campo `meshRotationY`, que as outras 348 têm. Essa parte
está certa, porque o campo é cópia do `mesh_rotation_y` (item 8). Falta aplicar
nas outras 348.

**Corrigir.** Acrescentar `"locate": "andar 1"` nos dois json.
**Teste.** Os 350 json têm `locate`, e ele é igual ao `local` do `fotos.geojson`.

## 15. As 2 fotos novas não têm nenhum `next`

`PIC_20260520_153807` tem 5 alvos e `PIC_20260520_153904` tem 1. Nenhum dos 6
traz o booleano `next`. Todos trazem `"icon": "next"`, que é outra coisa: o
`icon` desenha o ícone, o `next` marca o sentido do percurso.

Isso piorou o item 5: as fotos sem saída `next` passaram de 63 para 65.

**Corrigir.** Marcar `"next": true` no alvo que continua o percurso.

## 5. A cadeia `next` não fecha

| saídas `next` | fotos | | entradas `next` | fotos |
|---|---|---|---|---|
| 0 | 65 | | 0 | 60 |
| 1 | 253 | | 1 | 261 |
| 2 | 30 | | 2 | 29 |
| 3 | 2 | | | |

Fotos sem `next` por andar: `andar 1` 34 de 79, `andar 5` 11 de 82, `área
externa` 7 de 86, `andar 3` 5 de 12, `andar 4` 3 de 45, `andar 2` 2 de 20,
`andar 6` 2 de 18, `campo` 1 de 8.

**Corrigir.** Uma saída `next` por foto, a última sem.

## 6. O `ele` é zero em 207 de 350

| andar | min | max | zeros |
|---|---|---|---|
| andar 4 | 0,0 | 0,0 | 45 de 45 |
| campo de futebol | 0,0 | 0,0 | 8 de 8 |
| andar 1 | 0,0 | 19,7 | 77 de 79 |
| andar 2 | 0,0 | 26,6 | 17 de 20 |
| andar 5 | 0,0 | 75,7 | 48 de 82 |
| andar 6 | 0,0 | 66,1 | 3 de 18 |
| andar 3 | 0,0 | 118,3 | 8 de 12 |
| área externa | 0,0 | 100,6 | 1 de 86 |

As 2 fotos novas trouxeram 19,7 e 12,8, e são as únicas do `andar 1` com valor.
Onde o `ele` existe, ele não descreve andar: o andar 3 chega a 118,3 m e a
arquibancada tem ordem de 40 m.

**Corrigir.** Altura real de piso, ou campo nulo. Zero parece medida.

## 7. O `initialYaw` é ruído

Sem mudança. 341 dos 350 valores estão fora de 0 a 360, de -26.988,6 a 4.578,2
graus. As 2 fotos novas entraram com 2169,2 e 2522,2.

No `codigo_exemplo/index.html`: `cameraYaw` começa em 0 (linha 671), o arrasto
faz `cameraYaw -= dx * 0,2` sem normalizar (1131), e o salvamento grava o valor
do instante do clique (1286). Na leitura ele só entra com `isInitialLoad`
(1010), ou seja, no primeiro panorama da sessão.

Estatística circular contra o mundo (R perto de 0 é ruído):

| comparação | n | R |
|---|---|---|
| `initialYaw` mod 360 contra `heading` | 348 | 0,136 |
| `initialYaw` mod 360 contra azimute do primeiro `next` | 285 | 0,135 |

**Corrigir.** Tirar o campo da entrega.

## 8. O `mesh_rotation_y` é constante e ninguém o aplica

Sem mudança. Vale 60 nas 350, e o `mesh_rotation_y_img` do `fotos.geojson`
também. O `meshRotationY` repete o valor em 348 das 350.

O visualizador nunca usa esse campo. Ele aplica `textureRotation` (linha 911),
que é 0 nas 350. O 60 não passou por medida.

O X e o Z estão calibrados de verdade, com 43 valores distintos cada, inteiros,
dentro de -30 a 30. Só o rumo não está.

**Corrigir.** Calibrar o rumo e entregar o valor medido. Sem calibração,
entregar nulo. Remover o `meshRotationY` das 348, como já foi feito nas 2 novas.

## 9. O `fotos_linha.geojson` são tocos de 2 vértices

O arquivo foi regravado em 2026-08-05, com o mesmo conteúdo. 161 feições, 128
com só 2 vértices, 76 com `faixa_img` nulo.

A distribuição não bate com a das fotos. O `andar 2` tem 20 fotos e 1 linha, e o
`andar 6` tem 18 fotos e 1 linha. Já o `andar 1` tem 79 fotos e 78 linhas.

Como camada de percurso não serve. Desenha ligações entre pares, não o caminho.

**Corrigir.** Uma linha por sessão, vértices em ordem de tempo, `faixa_img`
preenchido. Sem faixa no levantamento a pé, uma linha por andar.

## 10. Quarenta e duas pastas de `dados_brutos` sem foto entregue

309 pastas `PIC_*` contra 267 prefixos entregues. Eram 45 antes das 2 fotos
novas. Cerca de 40 MB por pasta.

**Corrigir.** Dizer se o descarte foi de propósito, com o motivo.

## 11. Os `_original.jpg` têm a mesma dimensão do entregue

| arquivo | dimensão | peso |
|---|---|---|
| `<nome>.jpg` | 7680 x 3840 | 1,8 GB |
| `<nome>_original.jpg` | 7680 x 3840 | 4,1 GB |

Só muda a compressão. Dobra a entrega sem acrescentar pixel.

**Corrigir.** Confirmar se o `_original` precisa vir.

## 12. `cameraHeight` no padrão de fábrica em 70 fotos

2,1 em 242 fotos, 2,5 em 70, 1,8 em 25, 2,0 em 12, 1,7 em 1.

2,5 é o valor com que o visualizador nasce (`index.html`, linha 808). As 70 são
as que ninguém ajustou.

**Corrigir.** Medir ou deixar nulo.
