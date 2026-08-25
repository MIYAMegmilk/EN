# -*- coding: utf-8 -*-
"""
居酒屋の個室（6畳・座敷）を組み立てるビルドスクリプト。

用途:
  Web アプリの部屋リストページを Google ストリートビュー風に歩き回り、
  横の襖から個室に入る — その個室の中身。
  カメラは「部屋の中」に置かれる前提なので、壁は必ず厚みのある箱で作り、
  内側を向く面が実体としてある状態にしている（板1枚だと裏面が消える）。

座標系:
  部屋の内寸は X 3.64m × Y 2.73m × Z 2.40m（＝ちょうど6畳）。
  原点は部屋の中心の畳面。畳の上面が z = 0。
  襖（入口 = 廊下側）は -Y、障子窓は +Y、短冊メニューは -X、床の間は +X。

実行:
  Blender の Python から exec(open(path).read()) で流す。
  何度流しても同じ結果になるよう、頭で自分のコレクションを消してから作り直す。
"""

import bpy
import math
from mathutils import Vector

# ---------------------------------------------------------------- 寸法定数

ROOM_W = 3.64          # X 内寸（畳の長辺 1.82 × 2）
ROOM_D = 2.73          # Y 内寸（畳の長辺 1.82 + 短辺 0.91）
ROOM_H = 2.40          # 天井高
WALL_T = 0.12          # 壁の厚み
TATAMI_T = 0.055       # 畳の厚み
HERI_W = 0.045         # 畳縁（へり）の幅

HX = ROOM_W / 2.0      # 1.82
HY = ROOM_D / 2.0      # 1.365

ROOT = "IzakayaRoom"   # 生成物をまとめるコレクション名


# ---------------------------------------------------------------- 下ごしらえ

def reset():
    """前回の生成物を消す。手で置いた物は触らない。"""
    col = bpy.data.collections.get(ROOT)
    if col:
        for ob in list(col.objects):
            bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.collections.remove(col)
    # 孤立したメッシュ／マテリアルを掃除する（作り直しでゴミが溜まるため）
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.curves):
        for item in list(block):
            if item.users == 0:
                block.remove(item)
    col = bpy.data.collections.new(ROOT)
    bpy.context.scene.collection.children.link(col)
    return col


COL = None  # reset() で入る


def link(ob):
    COL.objects.link(ob)
    return ob


# ---------------------------------------------------------------- マテリアル

MATS = {}


def mat(name, color, rough=0.8, metal=0.0, emit=None, emit_str=0.0, alpha=1.0):
    """Principled BSDF を1枚。glTF に素直に出る範囲の入力だけ使う。"""
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    # ノード名は UI 言語で変わるので、型で拾う
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit is not None:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emit_str
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        m.blend_method = "BLEND"
    MATS[name] = m
    return m


def add_bump(name, scale=22.0, detail=4.0, strength=0.22, roughness=0.6):
    """土壁や布に細かい凹凸を足す。ベタ塗りの面は光が乗らず板に見えるため。
    手続き型テクスチャなので glTF には出ない。web に持っていくときは
    ベイクするか、タイル画像に差し替える前提。"""
    m = MATS[name]
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tex = nt.nodes.new("ShaderNodeTexNoise")
    tex.location = (-600, -200)
    tex.inputs["Scale"].default_value = scale
    tex.inputs["Detail"].default_value = detail
    tex.inputs["Roughness"].default_value = roughness
    bump = nt.nodes.new("ShaderNodeBump")
    bump.location = (-320, -200)
    bump.inputs["Strength"].default_value = strength
    nt.links.new(tex.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def add_weave(name, direction="Y", scale=90.0, strength=0.30):
    """畳目。細い縞を法線だけに入れて、畳の向きが読めるようにする。"""
    m = MATS[name]
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    coord.location = (-900, -220)
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.location = (-660, -220)
    wave.wave_type = "BANDS"
    wave.bands_direction = direction
    wave.wave_profile = "SIN"
    wave.inputs["Scale"].default_value = scale
    wave.inputs["Distortion"].default_value = 1.2
    wave.inputs["Detail"].default_value = 1.0
    nt.links.new(coord.outputs["Object"], wave.inputs["Vector"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.location = (-320, -220)
    bump.inputs["Strength"].default_value = strength
    nt.links.new(wave.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def build_materials():
    mat("M_Tatami_H",    (0.50, 0.51, 0.29), rough=0.90)   # 横置き（長辺が X）
    mat("M_Tatami_V",    (0.50, 0.51, 0.29), rough=0.90)   # 縦置き（長辺が Y）
    mat("M_TatamiHeri",  (0.10, 0.11, 0.16), rough=0.80)
    mat("M_FloorBase",   (0.06, 0.05, 0.04), rough=0.95)
    mat("M_Wall",        (0.42, 0.35, 0.26), rough=0.95)   # 聚楽壁ふうの土壁
    mat("M_WoodDark",    (0.13, 0.08, 0.05), rough=0.55)   # 柱・鴨居・framing
    mat("M_WoodMid",     (0.26, 0.16, 0.09), rough=0.60)   # 座卓・棚
    mat("M_WoodLight",   (0.40, 0.27, 0.16), rough=0.65)   # 天井板・竿縁
    mat("M_Paper",       (0.86, 0.82, 0.72), rough=0.90,   # 障子紙（廊下の灯りが透ける）
        emit=(1.00, 0.86, 0.62), emit_str=0.9)
    mat("M_Fusuma",      (0.72, 0.66, 0.52), rough=0.90)   # 襖紙
    mat("M_Tanzaku",     (0.90, 0.87, 0.78), rough=0.92)   # 短冊メニュー
    mat("M_Lantern",     (0.95, 0.70, 0.36), rough=0.65,   # 提灯の紙
        emit=(1.00, 0.55, 0.22), emit_str=2.4)
    mat("M_LanternRib",  (0.35, 0.10, 0.08), rough=0.70)   # 提灯の輪郭・口輪
    mat("M_Cushion",     (0.38, 0.09, 0.10), rough=0.92)   # 座布団（えんじ）
    mat("M_CushionAlt",  (0.10, 0.16, 0.30), rough=0.92)   # 座布団（藍）
    mat("M_Metal",       (0.35, 0.30, 0.24), rough=0.35, metal=1.0)
    mat("M_Ceramic",     (0.88, 0.86, 0.80), rough=0.25)   # 徳利・猪口
    mat("M_CeramicDark", (0.12, 0.12, 0.14), rough=0.30)   # 土鍋・小皿
    mat("M_Glass",       (0.80, 0.85, 0.88), rough=0.10, alpha=0.35)
    mat("M_Beer",        (0.85, 0.55, 0.10), rough=0.20)
    mat("M_Foam",        (0.96, 0.94, 0.86), rough=0.85)
    mat("M_Scroll",      (0.80, 0.75, 0.63), rough=0.90)   # 掛け軸

    mat("M_Noren",       (0.055, 0.075, 0.135), rough=0.95)  # 暖簾（藍）
    # ベタ面に凹凸を入れる。ここを省くと壁も畳も板に見える。
    add_bump("M_Wall", scale=30.0, detail=6.0, strength=0.30)
    add_bump("M_Fusuma", scale=45.0, detail=3.0, strength=0.12)
    add_bump("M_Cushion", scale=60.0, detail=2.0, strength=0.35)
    add_bump("M_CushionAlt", scale=60.0, detail=2.0, strength=0.35)
    add_bump("M_Noren", scale=70.0, detail=2.0, strength=0.25)
    add_bump("M_Paper", scale=120.0, detail=2.0, strength=0.08)
    add_weave("M_Tatami_H", direction="Y")
    add_weave("M_Tatami_V", direction="X")


# ---------------------------------------------------------------- 形の道具

CUBE_FACES = [
    (0, 3, 2, 1),  # 底 (-Z)
    (4, 5, 6, 7),  # 天 (+Z)
    (0, 1, 5, 4),  # 手前 (-Y)
    (1, 2, 6, 5),  # 右 (+X)
    (2, 3, 7, 6),  # 奥 (+Y)
    (3, 0, 4, 7),  # 左 (-X)
]


def box(name, size, center, material=None, rot_z=0.0):
    """外向き法線の直方体。size は各軸の全長。"""
    sx, sy, sz = (s * 0.5 for s in size)
    v = [
        (-sx, -sy, -sz), (sx, -sy, -sz), (sx, sy, -sz), (-sx, sy, -sz),
        (-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz),
    ]
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], CUBE_FACES)
    me.update()
    ob = bpy.data.objects.new(name, me)
    ob.location = center
    if rot_z:
        ob.rotation_euler = (0.0, 0.0, rot_z)
    if material:
        ob.data.materials.append(MATS[material])
    return link(ob)


def cyl(name, radius, height, center, material=None, verts=16, rot=(0, 0, 0)):
    """Z 方向に立つ円柱。"""
    me = bpy.data.meshes.new(name)
    vs, fs = [], []
    hh = height * 0.5
    for i in range(verts):
        a = 2.0 * math.pi * i / verts
        vs.append((radius * math.cos(a), radius * math.sin(a), -hh))
    for i in range(verts):
        a = 2.0 * math.pi * i / verts
        vs.append((radius * math.cos(a), radius * math.sin(a), hh))
    for i in range(verts):
        j = (i + 1) % verts
        fs.append((i, j, j + verts, i + verts))
    fs.append(tuple(range(verts - 1, -1, -1)))          # 底
    fs.append(tuple(range(verts, verts * 2)))            # 天
    me.from_pydata(vs, [], fs)
    me.update()
    for poly in me.polygons[:verts]:                     # 側面だけ滑らかに
        poly.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    ob.location = center
    ob.rotation_euler = rot
    if material:
        ob.data.materials.append(MATS[material])
    return link(ob)


def tube(name, r_profile, height, center, material=None, verts=20):
    """半径がZで変わる回転体（提灯・徳利など）。r_profile は [(t, r), ...] で t は 0..1。"""
    me = bpy.data.meshes.new(name)
    vs, fs = [], []
    rings = len(r_profile)
    for t, r in r_profile:
        z = -height * 0.5 + height * t
        for i in range(verts):
            a = 2.0 * math.pi * i / verts
            vs.append((r * math.cos(a), r * math.sin(a), z))
    for k in range(rings - 1):
        for i in range(verts):
            j = (i + 1) % verts
            a0 = k * verts + i
            b0 = k * verts + j
            fs.append((a0, b0, b0 + verts, a0 + verts))
    fs.append(tuple(range(verts - 1, -1, -1)))
    fs.append(tuple(range((rings - 1) * verts, rings * verts)))
    me.from_pydata(vs, [], fs)
    me.update()
    for poly in me.polygons[:(rings - 1) * verts]:
        poly.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    ob.location = center
    if material:
        ob.data.materials.append(MATS[material])
    return link(ob)


# ---------------------------------------------------------------- 床（畳6枚）

# 6畳の祝儀敷き。十字に四隅が集まらないよう、縦1枚を左右に噛ませた並び。
# (x0, y0, x1, y1) は部屋の隅を原点とした畳の外形。
TATAMI_LAYOUT = [
    (0.00, 0.00, 0.91, 1.82),   # 縦
    (0.91, 0.00, 2.73, 0.91),   # 横
    (0.91, 0.91, 2.73, 1.82),   # 横
    (2.73, 0.00, 3.64, 1.82),   # 縦
    (0.00, 1.82, 1.82, 2.73),   # 横
    (1.82, 1.82, 3.64, 2.73),   # 横
]


def build_floor():
    # 畳の下の根太板。畳を持ち上げた分の隙間を黒く埋める。
    box("Floor_Base", (ROOM_W + WALL_T * 2, ROOM_D + WALL_T * 2, 0.10),
        (0.0, 0.0, -TATAMI_T - 0.05), "M_FloorBase")

    for n, (x0, y0, x1, y1) in enumerate(TATAMI_LAYOUT, start=1):
        w, d = x1 - x0, y1 - y0
        cx, cy = (x0 + x1) * 0.5 - HX, (y0 + y1) * 0.5 - HY
        box(f"Tatami_{n:02d}", (w - 0.006, d - 0.006, TATAMI_T),
            (cx, cy, -TATAMI_T * 0.5), "M_Tatami_H" if w > d else "M_Tatami_V")

        # 畳縁は長辺の2本だけに付く。上面から気持ち出しておくと畳の割りが読める。
        if w > d:   # 横置き = 長辺が X
            for s in (-1, 1):
                box(f"Heri_{n:02d}_{'A' if s < 0 else 'B'}",
                    (w - 0.006, HERI_W, 0.014),
                    (cx, cy + s * (d * 0.5 - HERI_W * 0.5 - 0.003), -0.005),
                    "M_TatamiHeri")
        else:       # 縦置き = 長辺が Y
            for s in (-1, 1):
                box(f"Heri_{n:02d}_{'A' if s < 0 else 'B'}",
                    (HERI_W, d - 0.006, 0.014),
                    (cx + s * (w * 0.5 - HERI_W * 0.5 - 0.003), cy, -0.005),
                    "M_TatamiHeri")


# ---------------------------------------------------------------- 壁と天井

DOOR_W = 1.80          # 襖の開口幅（襖 0.90 × 2枚）
DOOR_H = 1.80          # 襖の開口高
WIN_W = 2.20           # 障子窓の開口幅
WIN_SILL = 0.75        # 窓台の高さ
WIN_HEAD = 1.95        # 窓の上端
ALC_W = 1.25           # 床の間の間口
ALC_H = 2.00           # 床の間の高さ
ALC_D = 0.28           # 床の間の奥行き
ALC_Y = 0.325          # 床の間の中心 Y


def build_walls():
    outer_w = ROOM_W + WALL_T * 2
    outer_d = ROOM_D + WALL_T * 2

    # --- -Y 側：廊下に面した入口。襖の開口をまたぐように分割して積む
    y_s = -(HY + WALL_T * 0.5)
    side_w = (outer_w - DOOR_W) * 0.5
    for s in (-1, 1):
        box(f"WallS_Side_{'L' if s < 0 else 'R'}",
            (side_w, WALL_T, DOOR_H),
            (s * (DOOR_W + side_w) * 0.5, y_s, DOOR_H * 0.5), "M_Wall")
    # 鴨居（開口の上に渡る横木）
    box("Kamoi", (outer_w, WALL_T + 0.02, 0.12), (0.0, y_s, DOOR_H + 0.06), "M_WoodDark")
    # 欄間の左右と天井際。欄間の抜けは 1.80 × 0.38。
    ranma_top = DOOR_H + 0.12 + 0.38
    for s in (-1, 1):
        box(f"WallS_Ranma_{'L' if s < 0 else 'R'}",
            (side_w, WALL_T, 0.38),
            (s * (DOOR_W + side_w) * 0.5, y_s, DOOR_H + 0.12 + 0.19), "M_Wall")
    box("WallS_Top", (outer_w, WALL_T, ROOM_H - ranma_top),
        (0.0, y_s, (ranma_top + ROOM_H) * 0.5), "M_Wall")
    # 欄間の格子。廊下の灯りが透けて、ここが入口だと分かる目印になる。
    for i in range(13):
        x = -DOOR_W * 0.5 + 0.07 + i * (DOOR_W - 0.14) / 12.0
        box(f"Ranma_Slat_{i:02d}", (0.022, 0.05, 0.34), (x, -HY - 0.03, DOOR_H + 0.31), "M_WoodDark")
    # 敷居（畳と廊下の境。襖が走る溝の見え）
    box("Shikii", (DOOR_W + 0.10, WALL_T + 0.02, 0.05), (0.0, y_s, -0.010), "M_WoodDark")

    # --- +Y 側：障子窓の壁
    y_n = HY + WALL_T * 0.5
    box("WallN_Below", (outer_w, WALL_T, WIN_SILL), (0.0, y_n, WIN_SILL * 0.5), "M_Wall")
    box("WallN_Above", (outer_w, WALL_T, ROOM_H - WIN_HEAD), (0.0, y_n, (WIN_HEAD + ROOM_H) * 0.5), "M_Wall")
    n_side_w = (outer_w - WIN_W) * 0.5
    for s in (-1, 1):
        box(f"WallN_Side_{'L' if s < 0 else 'R'}",
            (n_side_w, WALL_T, WIN_HEAD - WIN_SILL),
            (s * (WIN_W + n_side_w) * 0.5, y_n, (WIN_SILL + WIN_HEAD) * 0.5), "M_Wall")
    # 窓台と窓の上枠
    box("Win_Sill", (WIN_W + 0.12, WALL_T + 0.05, 0.06), (0.0, HY - 0.005, WIN_SILL - 0.03), "M_WoodDark")
    box("Win_Head", (WIN_W + 0.12, WALL_T + 0.05, 0.06), (0.0, HY - 0.005, WIN_HEAD + 0.03), "M_WoodDark")

    # --- -X 側：短冊メニューを貼る面。開口なしの一枚壁。
    box("WallW", (WALL_T, outer_d, ROOM_H), (-(HX + WALL_T * 0.5), 0.0, ROOM_H * 0.5), "M_Wall")

    # --- +X 側：床の間（飾り棚）を彫った壁
    x_e = HX + WALL_T * 0.5
    y_lo, y_hi = ALC_Y - ALC_W * 0.5, ALC_Y + ALC_W * 0.5
    seg_front = y_lo - (-HY - WALL_T)          # 手前側の残り
    box("WallE_Front", (WALL_T, seg_front, ROOM_H),
        (x_e, (-HY - WALL_T + y_lo) * 0.5, ROOM_H * 0.5), "M_Wall")
    seg_back = (HY + WALL_T) - y_hi
    box("WallE_Back", (WALL_T, seg_back, ROOM_H),
        (x_e, (y_hi + HY + WALL_T) * 0.5, ROOM_H * 0.5), "M_Wall")
    box("WallE_AboveAlcove", (WALL_T, ALC_W, ROOM_H - ALC_H),
        (x_e, ALC_Y, (ALC_H + ROOM_H) * 0.5), "M_Wall")

    # 床の間の内側（奥・両脇・天井・床板）
    box("Alcove_Back", (WALL_T, ALC_W + WALL_T * 2, ALC_H),
        (HX + ALC_D + WALL_T * 0.5, ALC_Y, ALC_H * 0.5), "M_Wall")
    for s, tag in ((-1, "F"), (1, "B")):
        box(f"Alcove_Side_{tag}", (ALC_D, WALL_T, ALC_H),
            (HX + ALC_D * 0.5, ALC_Y + s * (ALC_W + WALL_T) * 0.5, ALC_H * 0.5), "M_Wall")
    box("Alcove_Ceil", (ALC_D, ALC_W, WALL_T),
        (HX + ALC_D * 0.5, ALC_Y, ALC_H + WALL_T * 0.5), "M_Wall")
    # 床板は畳より少し上げる（床の間らしさが出る）
    box("Alcove_Floor", (ALC_D, ALC_W, 0.12), (HX + ALC_D * 0.5, ALC_Y, 0.06), "M_WoodMid")
    # 落し掛け（床の間の上端に渡る横木）と床柱
    box("Otoshigake", (ALC_D + 0.03, ALC_W + 0.02, 0.10), (HX + ALC_D * 0.5, ALC_Y, ALC_H - 0.05), "M_WoodDark")
    cyl("Tokobashira", 0.055, ALC_H, (HX - 0.05, y_lo - 0.02, ALC_H * 0.5), "M_WoodDark", verts=12)

    # --- 天井：板張り＋竿縁
    box("Ceiling", (outer_w, outer_d, WALL_T), (0.0, 0.0, ROOM_H + WALL_T * 0.5), "M_WoodLight")
    for i in range(5):
        y = -1.10 + i * 0.55
        box(f"Saobuchi_{i}", (ROOM_W, 0.05, 0.045), (0.0, y, ROOM_H - 0.0225), "M_WoodDark")

    # --- 四隅の柱と回り縁。和室の骨格として効く。
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(f"Pillar_{'W' if sx < 0 else 'E'}{'S' if sy < 0 else 'N'}",
                (0.12, 0.12, ROOM_H),
                (sx * (HX - 0.06), sy * (HY - 0.06), ROOM_H * 0.5), "M_WoodDark")
    for sy in (-1, 1):
        box(f"Mawaribuchi_{'S' if sy < 0 else 'N'}", (ROOM_W, 0.06, 0.06),
            (0.0, sy * (HY - 0.03), ROOM_H - 0.03), "M_WoodDark")
    for sx in (-1, 1):
        box(f"Mawaribuchi_{'W' if sx < 0 else 'E'}", (0.06, ROOM_D, 0.06),
            (sx * (HX - 0.03), 0.0, ROOM_H - 0.03), "M_WoodDark")


# ---------------------------------------------------------------- 建具

def build_fusuma():
    """入口の襖。左を右に寄せて引き開けた状態にし、廊下から入ってきた導線を見せる。"""
    # 溝は2本。開けた左戸が奥（-Y 寄り）、閉じた右戸が手前に見える並びにする。
    tracks = {"L": -HY - 0.075, "R": -HY - 0.038}
    # 左戸は右戸に重ねて格納 → x 0.00〜0.90 が開口として抜ける
    for tag, cx in (("L", 0.44), ("R", 0.45)):
        y = tracks[tag]
        box(f"Fusuma_{tag}_Panel", (0.90, 0.026, DOOR_H - 0.02), (cx, y, DOOR_H * 0.5), "M_Fusuma")
        # 縁（框）。上下は細く、左右は太く見せる。
        for s in (-1, 1):
            box(f"Fusuma_{tag}_Stile_{s}", (0.05, 0.032, DOOR_H - 0.02),
                (cx + s * 0.425, y, DOOR_H * 0.5), "M_WoodDark")
            box(f"Fusuma_{tag}_Rail_{s}", (0.90, 0.032, 0.05),
                (cx, y, DOOR_H * 0.5 + s * (DOOR_H * 0.5 - 0.035)), "M_WoodDark")
        # 引手
        box(f"Fusuma_{tag}_Pull", (0.075, 0.010, 0.11), (cx - 0.31, y - 0.017, 0.92), "M_Metal")


def build_shoji_window():
    """障子窓。外に淡く光る面を置いて、夜の店先の灯りが透ける感じにする。"""
    h = WIN_HEAD - WIN_SILL
    for tag, cx, y in (("L", -0.55, HY - 0.055), ("R", 0.55, HY - 0.022)):
        box(f"Shoji_{tag}_Paper", (WIN_W * 0.5, 0.010, h - 0.02), (cx, y, WIN_SILL + h * 0.5), "M_Paper")
        for s in (-1, 1):
            box(f"Shoji_{tag}_Stile_{s}", (0.04, 0.026, h - 0.02),
                (cx + s * (WIN_W * 0.25 - 0.02), y, WIN_SILL + h * 0.5), "M_WoodDark")
            box(f"Shoji_{tag}_Rail_{s}", (WIN_W * 0.5, 0.026, 0.045),
                (cx, y, WIN_SILL + h * 0.5 + s * (h * 0.5 - 0.032)), "M_WoodDark")
        # 組子（縦3・横4）。障子は格子が入って初めて障子に見える。
        for i in range(3):
            x = cx - WIN_W * 0.25 + (i + 1) * (WIN_W * 0.5) / 4.0
            box(f"Shoji_{tag}_V{i}", (0.016, 0.022, h - 0.09), (x, y - 0.014, WIN_SILL + h * 0.5), "M_WoodDark")
        for j in range(4):
            z = WIN_SILL + 0.06 + (j + 1) * (h - 0.12) / 5.0
            box(f"Shoji_{tag}_H{j}", (WIN_W * 0.5 - 0.08, 0.022, 0.014), (cx, y - 0.014, z), "M_WoodDark")

    # 窓の外。夜の路地の灯りに見立てた発光面。
    m = mat("M_NightGlow", (0.30, 0.34, 0.45), rough=1.0, emit=(0.55, 0.60, 0.85), emit_str=2.2)
    ob = box("Window_Backdrop", (WIN_W + 0.4, 0.04, (WIN_HEAD - WIN_SILL) + 0.4),
             (0.0, HY + WALL_T + 0.10, (WIN_SILL + WIN_HEAD) * 0.5))
    ob.data.materials.append(m)


def build_corridor():
    """廊下の作り置き。個室単体では窓も入口も「向こう側」が無いと穴に見えるため、
    開いた襖の先に一区画だけ廊下を張っておく。書き出し時に丸ごと外せるよう名前を揃える。"""
    y0, y1 = -(HY + WALL_T), -3.30       # 廊下の奥行き
    cy = (y0 + y1) * 0.5
    depth = y0 - y1
    # 座敷は廊下より一段高い。段差があると「上がって入る」動線が読める。
    box("Corridor_Floor", (5.2, depth, 0.10), (0.0, cy, -0.23), "M_WoodMid")
    box("Corridor_Ceil", (5.2, depth, 0.10), (0.0, cy, 2.25), "M_WoodDark")
    box("Corridor_BackWall", (5.2, WALL_T, 2.40), (0.0, y1 - WALL_T * 0.5, 1.02), "M_Wall")
    for s in (-1, 1):
        box(f"Corridor_SideWall_{s}", (WALL_T, depth, 2.40), (s * 2.6, cy, 1.02), "M_Wall")
    # 上がり框（座敷に上がる段板）
    box("Agarikamachi", (DOOR_W + 0.30, 0.10, 0.24), (0.0, y0 - 0.05, -0.06), "M_WoodDark")
    # 廊下の縄暖簾がわりの短い暖簾。入口の目印。
    for i in range(5):
        x = -0.87 + i * 0.215
        box(f"Corridor_Noren_{i}", (0.20, 0.008, 0.34), (x, y0 - 0.16, ROOM_H - 0.47), "M_Noren")
    box("Corridor_NorenRod", (DOOR_W + 0.10, 0.022, 0.022), (0.0, y0 - 0.16, ROOM_H - 0.29), "M_WoodDark")


# ---------------------------------------------------------------- 壁の飾り

def build_wall_decor():
    """短冊メニュー・掛け軸・呼び出しボタン。居酒屋の個室だと分かる手掛かりを壁に置く。"""
    x_w = -HX + 0.008    # 西壁の面すれすれ

    # 短冊メニュー。縦長の紙を不揃いに貼る。揃えすぎると居酒屋に見えない。
    jitter = [0.0, 0.03, -0.02, 0.015, -0.035, 0.01, 0.025, -0.015,
              0.02, -0.03, 0.0, 0.03, -0.01, 0.02]
    n = 0
    for row, z in ((0, 1.62), (1, 1.20)):
        for i in range(7):
            y = -1.02 + i * 0.34
            box(f"Tanzaku_{n:02d}", (0.006, 0.115, 0.34),
                (x_w, y + jitter[n] * 0.5, z + jitter[n]), "M_Tanzaku")
            n += 1

    # 呼び出しボタン（座卓の脇の壁、座ったまま届く高さ）
    box("CallButton_Plate", (0.020, 0.10, 0.10), (x_w, -0.60, 0.62), "M_WoodDark")
    m = mat("M_ButtonRed", (0.55, 0.06, 0.06), rough=0.4, emit=(1.0, 0.15, 0.10), emit_str=1.5)
    b = cyl("CallButton", 0.022, 0.016, (x_w - 0.014, -0.60, 0.62), verts=12,
            rot=(0.0, math.pi * 0.5, 0.0))
    b.data.materials.append(m)

    # コート掛け（入口寄りの壁）
    box("HookRail", (0.03, 0.62, 0.05), (x_w, -1.02, 1.72), "M_WoodDark")
    for i in range(3):
        cyl(f"Hook_{i}", 0.011, 0.09, (x_w - 0.045, -1.26 + i * 0.24, 1.70), "M_Metal",
            verts=8, rot=(0.0, math.pi * 0.5, 0.0))

    # 掛け軸（床の間の奥）
    xb = HX + ALC_D - 0.012
    box("Kakejiku_Paper", (0.008, 0.40, 1.05), (xb, ALC_Y, 1.28), "M_Scroll")
    for s in (-1, 1):
        cyl(f"Kakejiku_Roller_{s}", 0.022, 0.46, (xb - 0.008, ALC_Y, 1.28 + s * 0.545),
            "M_WoodDark", verts=10, rot=(math.pi * 0.5, 0.0, 0.0))

    # 床の間の飾り：一升瓶と小さな盆
    tube("SakeBottle", [(0.0, 0.055), (0.55, 0.058), (0.68, 0.030), (0.80, 0.022),
                        (1.0, 0.024)], 0.36, (HX + 0.13, ALC_Y - 0.28, 0.12 + 0.18),
         "M_CeramicDark", verts=14)
    box("Alcove_Tray", (0.20, 0.26, 0.018), (HX + 0.14, ALC_Y + 0.22, 0.12 + 0.009), "M_WoodDark")
    tube("Alcove_Vase", [(0.0, 0.045), (0.35, 0.070), (0.75, 0.040), (1.0, 0.046)],
         0.22, (HX + 0.14, ALC_Y + 0.22, 0.12 + 0.018 + 0.11), "M_Ceramic", verts=14)


# ---------------------------------------------------------------- 座敷まわり

TBL_X, TBL_Y = -0.14, 0.00     # 座卓の中心
TBL_W, TBL_D = 1.50, 0.80      # 天板
TBL_H = 0.33                   # 座卓の高さ（座って使う低さ）


def build_table():
    top_z = TBL_H - 0.0225
    box("Table_Top", (TBL_W, TBL_D, 0.045), (TBL_X, TBL_Y, top_z), "M_WoodMid")
    # 天板の下に付く幕板。これが無いと板を浮かせただけに見える。
    for s in (-1, 1):
        box(f"Table_Apron_Y{s}", (TBL_W - 0.16, 0.03, 0.07),
            (TBL_X, TBL_Y + s * (TBL_D * 0.5 - 0.09), TBL_H - 0.085), "M_WoodMid")
        box(f"Table_Apron_X{s}", (0.03, TBL_D - 0.16, 0.07),
            (TBL_X + s * (TBL_W * 0.5 - 0.09), TBL_Y, TBL_H - 0.085), "M_WoodMid")
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(f"Table_Leg_{sx}_{sy}", (0.055, 0.055, TBL_H - 0.045),
                (TBL_X + sx * (TBL_W * 0.5 - 0.09), TBL_Y + sy * (TBL_D * 0.5 - 0.09),
                 (TBL_H - 0.045) * 0.5), "M_WoodDark")


def build_cushions():
    """座布団6枚。長辺に2枚ずつ、両端に1枚ずつ。色を2種混ぜて単調さを消す。"""
    spots = [
        (TBL_X - 0.40, TBL_Y - 0.74, 0.0, "M_Cushion"),
        (TBL_X + 0.40, TBL_Y - 0.74, 0.0, "M_CushionAlt"),
        (TBL_X - 0.40, TBL_Y + 0.74, 0.0, "M_CushionAlt"),
        (TBL_X + 0.40, TBL_Y + 0.74, 0.0, "M_Cushion"),
        (TBL_X - 1.10, TBL_Y, math.pi * 0.5, "M_Cushion"),
        (TBL_X + 1.10, TBL_Y, math.pi * 0.5, "M_CushionAlt"),
    ]
    for n, (x, y, rz, m) in enumerate(spots):
        # わずかに角度を散らすと、人が座って立った後の空気になる
        rz += (0.10 if n % 3 == 0 else -0.06 if n % 3 == 1 else 0.02)
        box(f"Zabuton_{n}", (0.58, 0.55, 0.065), (x, y, 0.032), m, rot_z=rz)
        box(f"Zabuton_{n}_Top", (0.50, 0.47, 0.020), (x, y, 0.070), m, rot_z=rz)


def build_tableware():
    """卓上。ジョッキ・徳利・土鍋・小皿まで置くと「宴の最中」に見える。"""
    z = TBL_H + 0.0025

    # 生ビールのジョッキ2つ
    for n, (dx, dy) in enumerate(((-0.46, -0.20), (-0.30, 0.19))):
        x, y = TBL_X + dx, TBL_Y + dy
        cyl(f"Mug_{n}_Glass", 0.044, 0.155, (x, y, z + 0.0775), "M_Glass", verts=14)
        cyl(f"Mug_{n}_Beer", 0.038, 0.115, (x, y, z + 0.062), "M_Beer", verts=14)
        cyl(f"Mug_{n}_Foam", 0.039, 0.028, (x, y, z + 0.133), "M_Foam", verts=14)
        box(f"Mug_{n}_Handle", (0.030, 0.014, 0.075), (x + 0.056, y, z + 0.080), "M_Glass")

    # 徳利と猪口2つ
    tube("Tokkuri", [(0.0, 0.040), (0.45, 0.052), (0.70, 0.024), (0.88, 0.019), (1.0, 0.024)],
         0.155, (TBL_X + 0.30, TBL_Y + 0.22, z + 0.0775), "M_Ceramic", verts=14)
    for n, (dx, dy) in enumerate(((0.42, 0.14), (0.40, 0.28))):
        tube(f"Choko_{n}", [(0.0, 0.017), (0.3, 0.020), (1.0, 0.028)],
             0.042, (TBL_X + dx, TBL_Y + dy, z + 0.021), "M_Ceramic", verts=12)

    # 土鍋（蓋つき）。個室の卓の主役。
    tube("Donabe", [(0.0, 0.105), (0.25, 0.145), (0.85, 0.150), (1.0, 0.143)],
         0.110, (TBL_X + 0.30, TBL_Y - 0.14, z + 0.055), "M_CeramicDark", verts=20)
    tube("Donabe_Lid", [(0.0, 0.148), (0.30, 0.140), (0.85, 0.075), (1.0, 0.030)],
         0.055, (TBL_X + 0.30, TBL_Y - 0.14, z + 0.1375), "M_CeramicDark", verts=20)
    cyl("Donabe_Knob", 0.026, 0.032, (TBL_X + 0.30, TBL_Y - 0.14, z + 0.181), "M_CeramicDark", verts=12)

    # 小皿・箸・箸置き
    for n, (dx, dy) in enumerate(((-0.62, 0.02), (0.62, -0.24), (-0.10, -0.28), (0.02, 0.27))):
        tube(f"Plate_{n}", [(0.0, 0.055), (0.6, 0.072), (1.0, 0.078)],
             0.018, (TBL_X + dx, TBL_Y + dy, z + 0.009), "M_Ceramic", verts=16)
        box(f"Chopsticks_{n}", (0.012, 0.225, 0.010),
            (TBL_X + dx + 0.11, TBL_Y + dy, z + 0.010), "M_WoodDark", rot_z=0.25 * (n - 1.5))
        box(f"Hashioki_{n}", (0.045, 0.022, 0.012),
            (TBL_X + dx + 0.11, TBL_Y + dy - 0.09, z + 0.006), "M_CeramicDark")

    # おしぼり（巻いて置いた状態）
    for n, (dx, dy) in enumerate(((-0.55, -0.30), (0.50, 0.30))):
        cyl(f"Oshibori_{n}", 0.028, 0.13, (TBL_X + dx, TBL_Y + dy, z + 0.028), "M_Foam",
            verts=12, rot=(0.0, math.pi * 0.5, 0.35))

    # 卓上メニュー立て
    box("MenuStand_Base", (0.13, 0.07, 0.012), (TBL_X + 0.66, TBL_Y + 0.22, z + 0.006), "M_WoodDark")
    box("MenuStand_Card", (0.125, 0.010, 0.185), (TBL_X + 0.66, TBL_Y + 0.235, z + 0.100), "M_Tanzaku")


# ---------------------------------------------------------------- 灯り

def _lerp_profile(profile, t):
    """回転体プロファイルの t 位置の半径を線形補間で拾う。"""
    for (t0, r0), (t1, r1) in zip(profile, profile[1:]):
        if t0 <= t <= t1:
            k = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            return r0 + (r1 - r0) * k
    return profile[-1][1]


def build_lanterns():
    """卓の上に提灯を2つ吊る。この部屋の光源であり、見た目の主役でもある。"""
    profile = [(0.00, 0.050), (0.12, 0.120), (0.35, 0.152), (0.62, 0.152),
               (0.86, 0.118), (1.00, 0.050)]
    for n, dx in ((0, -0.42), (1, 0.42)):
        x, y = TBL_X + dx, TBL_Y
        bottom, h = 1.58, 0.34
        cz = bottom + h * 0.5
        tube(f"Lantern_{n}_Body", profile, h, (x, y, cz), "M_Lantern", verts=20)
        # 口輪（上下の輪）と骨。輪郭が締まって提灯に見える。
        cyl(f"Lantern_{n}_RingB", 0.056, 0.018, (x, y, bottom + 0.006), "M_LanternRib", verts=16)
        cyl(f"Lantern_{n}_RingT", 0.056, 0.018, (x, y, bottom + h - 0.006), "M_LanternRib", verts=16)
        # 横骨。提灯の輪郭に沿って半径を補間しながら細い輪を重ねる。
        for k in range(1, 9):
            t = k / 9.0
            r = _lerp_profile(profile, t) + 0.004
            cyl(f"Lantern_{n}_Rib_{k}", r, 0.006, (x, y, bottom + h * t),
                "M_LanternRib", verts=20)
        # 屋号の帯
        cyl(f"Lantern_{n}_Band", _lerp_profile(profile, 0.5) + 0.002, 0.075,
            (x, y, bottom + h * 0.5), "M_LanternRib", verts=20)
        # 吊りコードと天井の引掛シーリング
        cyl(f"Lantern_{n}_Cord", 0.008, ROOM_H - (bottom + h),
            (x, y, (bottom + h + ROOM_H) * 0.5), "M_WoodDark", verts=8)
        cyl(f"Lantern_{n}_Rose", 0.045, 0.030, (x, y, ROOM_H - 0.015), "M_WoodDark", verts=12)

        lamp = bpy.data.lights.new(f"Lantern_{n}_Lamp", type="POINT")
        lamp.energy = 28.0
        lamp.color = (1.0, 0.74, 0.46)
        lamp.shadow_soft_size = 0.13
        link(bpy.data.objects.new(f"Lantern_{n}_Lamp", lamp)).location = (x, y, cz)


def build_lighting():
    """提灯だけだと足元と隅が潰れるので、天井際の弱い面光源で持ち上げる。"""
    fill = bpy.data.lights.new("Fill_Ceiling", type="AREA")
    fill.energy = 22.0
    fill.color = (1.0, 0.85, 0.68)
    fill.shape = "RECTANGLE"
    fill.size, fill.size_y = 2.6, 1.8
    link(bpy.data.objects.new("Fill_Ceiling", fill)).location = (0.0, 0.0, ROOM_H - 0.10)

    # 床の間の飾りを起こすスポット
    alc = bpy.data.lights.new("Alcove_Lamp", type="POINT")
    alc.energy = 9.0
    alc.color = (1.0, 0.80, 0.55)
    alc.shadow_soft_size = 0.10
    link(bpy.data.objects.new("Alcove_Lamp", alc)).location = (HX + 0.10, ALC_Y, ALC_H - 0.20)

    # 廊下側。襖の開いた側から光が差し込んで入口が読める。
    cor = bpy.data.lights.new("Corridor_Lamp", type="AREA")
    cor.energy = 45.0
    cor.color = (1.0, 0.78, 0.52)
    cor.shape = "RECTANGLE"
    cor.size, cor.size_y = 1.2, 0.5
    cor.energy = 30.0
    ob = link(bpy.data.objects.new("Corridor_Lamp", cor))
    ob.location = (0.0, -2.75, 2.05)


# ---------------------------------------------------------------- カメラ

def look_at(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


EYE = 1.55   # 立って見る目線の高さ

# パノラマの撮影地点。ストリートビューでいう「ノード」。
# 廊下 → 敷居際 → 室内 と繋げば、そのまま歩いて入る導線になる。
PANO_NODES = [
    ("CAM_Pano_Corridor", (-0.45, -2.30, EYE)),   # 廊下、襖の手前
    ("CAM_Pano_Door",     (-0.45, -1.12, EYE)),   # 入ってすぐ、敷居の内側
    ("CAM_Pano_Room",     (-1.28, 0.55, EYE)),    # 室内、窓寄りの空きスペース
]


def build_cameras():
    scene = bpy.context.scene

    def cam(name, loc, lens=24.0):
        data = bpy.data.cameras.new(name)
        data.lens = lens
        data.clip_start = 0.02
        ob = link(bpy.data.objects.new(name, data))
        ob.location = loc
        return ob

    # 1) 廊下から、開いた襖ごしに個室をのぞく画。部屋リストのサムネ向き。
    c1 = cam("CAM_Enter", (-0.45, -2.15, EYE), lens=22.0)
    look_at(c1, (TBL_X + 0.15, TBL_Y + 0.35, 1.05))

    # 2) 入って室内を見渡す画
    c2 = cam("CAM_Inside", (-1.30, -0.95, 1.48), lens=20.0)
    look_at(c2, (TBL_X + 0.55, TBL_Y + 0.30, 0.80))

    # 3) 座った目線
    c3 = cam("CAM_Seated", (TBL_X - 0.30, TBL_Y - 1.00, 0.95), lens=28.0)
    look_at(c3, (TBL_X + 0.25, TBL_Y + 0.15, 0.45))

    # 4) 360度パノラマの視点。ストリートビュー風にするなら、ここを Cycles の
    #    equirectangular で焼いて three.js の球に貼るのが早い。
    #    人が実際に立てる位置に置く。卓の真上から撮ると足元が天板で埋まる。
    for name, loc in PANO_NODES:
        c = cam(name, loc)
        c.rotation_euler = (math.pi * 0.5, 0.0, 0.0)
        try:
            c.data.type = "PANO"
            c.data.panorama_type = "EQUIRECTANGULAR"
        except (AttributeError, TypeError):
            pass   # EEVEE はパノラマカメラを持たず、通常投影に落ちる

    scene.camera = c1


# ---------------------------------------------------------------- シーン設定

def setup_scene():
    scene = bpy.context.scene
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.view_settings.view_transform = "AgX"
    # look の名前はバージョンで揺れるので、通るものを順に試す
    for look in ("AgX - Medium High Contrast", "AgX - Base Contrast", "None"):
        try:
            scene.view_settings.look = look
            break
        except TypeError:
            continue

    # 世界は暗く。部屋の中の光だけで成立させる。
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.035, 0.030, 0.026, 1.0)
        bg.inputs["Strength"].default_value = 1.0


def frame_viewport():
    """ビューポートをカメラ視点・マテリアルプレビューにする（確認用）。"""
    for area in bpy.context.screen.areas:
        if area.type != "VIEW_3D":
            continue
        for space in area.spaces:
            if space.type == "VIEW_3D":
                space.shading.type = "MATERIAL"
                space.shading.use_scene_lights = True
                space.shading.use_scene_world = True
                space.region_3d.view_perspective = "CAMERA"
                space.clip_start = 0.02
        area.tag_redraw()


# ---------------------------------------------------------------- 書き出し

def render_panos(out_dir, width=4096, samples=96):
    """Cycles で 360 度パノラマを焼く。EEVEE はパノラマカメラを無視するので必ず Cycles。"""
    import os
    scene = bpy.context.scene
    keep_engine, keep_cam = scene.render.engine, scene.camera
    keep_res = (scene.render.resolution_x, scene.render.resolution_y)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.render.resolution_x, scene.render.resolution_y = width, width // 2
    os.makedirs(out_dir, exist_ok=True)
    made = []
    for name, _ in PANO_NODES:
        scene.camera = bpy.data.objects[name]
        scene.render.filepath = os.path.join(out_dir, name + ".png")
        bpy.ops.render.render(write_still=True)
        made.append(scene.render.filepath)
    scene.render.engine = keep_engine
    scene.camera = keep_cam
    scene.render.resolution_x, scene.render.resolution_y = keep_res
    return made


def export_gltf(path):
    """three.js に渡す用。廊下は個室と別扱いにしたいので、必要なら先に隠す。"""
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_cameras=False,
        export_lights=True,
    )
    return path


# ---------------------------------------------------------------- 実行

def main():
    global COL
    COL = reset()
    build_materials()
    build_floor()
    build_walls()
    build_fusuma()
    build_shoji_window()
    build_corridor()
    build_wall_decor()
    build_table()
    build_cushions()
    build_tableware()
    build_lanterns()
    build_lighting()
    build_cameras()
    setup_scene()
    frame_viewport()
    n = len(COL.objects)
    print(f"[IzakayaRoom] built {n} objects")
    return n


if __name__ == "__main__":
    main()
