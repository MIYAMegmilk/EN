# -*- coding: utf-8 -*-
"""
居酒屋の廊下を組み立てるための部品キット。

■ なぜ「1区画まるごと」ではなく部品なのか
    廊下を曲げたり、T字・十字に分けたりすると、区画の形は「直線」「角」「T」「十字」…と
    増えていく。全部を作り置きすると組み合わせのぶんだけ増える一方なので、
    正方形のマス目に対して

        床天井（どのマスにも置く） ＋ 各辺の壁（塞ぐ辺にだけ置く）

    という足し算で組む。辺を開けるか塞ぐかを変えるだけで、直線も角もT字も十字も出る。
    行き止まりも「3辺を塞いだマス」でしかない。

■ マス目
    1辺 CELL の正方形。マスの中心が原点、床が z = 0。
    通り幅は CORR_W で、CELL との差が四隅の柱になる。
    柱は「+X+Y の隅」にだけ入れてある。

    【重要・この前提は間違っていた】
    「隅は4つのマスで共有するので、全マスを並べれば隣のマスの柱が残り3隅を埋める」
    と考えて1本だけにしたが、**埋まらない。**
    隣のマスの柱は「1マスぶん先の隅」を埋めるだけで、こちらの残り3隅には来ない。
    角ブロックは 1.00 四方で、それを4つのマスが 0.50 ずつ分け合う形になっており、
    どの角も 4 分の 1 しか埋まらない。
    結果、まっすぐな廊下でもマスの境目ごとに 0.5m 幅・天井まで届く縦穴が開く。
    （目線の高さの断面を塗り広げて測ると 17×17 マスで 767 m² ぶん、
      「見えてはいけない場所」へ抜けられた。tools/corridor-layout-check.js 参照）

    いまは **corridor-view.js 側で対処している。**読み込み時に Core_Post の三角形を
    Kit_Core から切り離し、0 / 90 / 180 / 270° に置き直して四隅を埋める（漏れ 0 を確認済み）。
    柱は「三角形が 0.50 × 2.35 × 0.50 の箱に丸ごと入るか」だけで特定しているので、
    **この box() の寸法・位置を変えると向こうが例外で止まる。**
    変えるときは corridor-view.js の POST_BOX も合わせること。

    アセット側で直すなら、Core_Post を Kit_Post として別ノードに出すのが筋が良い
    （Kit_Core に4本入れると、隣のマスのぶんと同じ場所で重なって面が喧嘩するため）。

■ 部品（この名前で three.js から拾う）
    Kit_Core      床・天井・隅柱・天井の梁。どのマスにも1つ置く
    Kit_Wall      塞ぐ辺に置く、扉の無い壁
    Kit_Door      塞ぐ辺に置く、扉つきの壁（下記の子を持つ空オブジェクト）
    Kit_Pendant   天井の灯り。マスによって間引いて置く

    Kit_Door の子:
        Door_Static   壁・鴨居・敷居・框・組子・木札の台。まとめて1つ
        Door_Paper    引き戸の紙。中の灯り。消えている卓は暗くする
        Door_Sign     木札。UV 0..1 の板。canvas を貼って卓の情報を描く
        Door_Lantern  提灯。遠くからの空席サイン。色を差し替える
        Door_Hit      クリック判定の板。透明にして raycast にだけ使う

■ 向き
    壁・扉は「+Y 側の辺」を塞ぐ形で作ってある。他の辺は Z 軸まわりに回して使う。
        +Y = 0°  /  +X = -90°  /  -Y = 180°  /  -X = +90°
    glTF に出すと Blender +Y は three.js の -Z になるので、+Y を「北」と読み替える。
"""

import bpy
import math

# ---------------------------------------------------------------- 寸法

CELL = 3.00         # マスの1辺
CORR_W = 2.00       # 廊下の通り幅
CORR_H = 2.35       # 天井高
WALL_T = 0.14
DOOR_W = 1.00       # 引き戸の開口幅
DOOR_H = 1.95       # 引き戸の開口高

HC = CELL / 2.0       # 1.50  マスの端まで
HW = CORR_W / 2.0     # 1.00  通りの端（＝壁の内側の面）まで
POST = HC - HW        # 0.50  隅柱の一辺

ROOT = "IzakayaKit"
PREVIEW = "IzakayaKit_Preview"

COL_OBJ = None
MATS = {}


# ---------------------------------------------------------------- 下ごしらえ

def reset():
    for name in (PREVIEW, ROOT):
        col = bpy.data.collections.get(name)
        if not col:
            continue
        for ob in list(col.objects):
            bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.collections.remove(col)
    # 起動時の Cube などが残っていると書き出しに混ざる
    for ob in list(bpy.context.scene.objects):
        if ob.type in {"MESH", "LIGHT", "EMPTY"}:
            bpy.data.objects.remove(ob, do_unlink=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights):
        for item in list(block):
            if item.users == 0:
                block.remove(item)
    col = bpy.data.collections.new(ROOT)
    bpy.context.scene.collection.children.link(col)
    return col


def link(ob):
    COL_OBJ.objects.link(ob)
    return ob


# ---------------------------------------------------------------- マテリアル

def mat(name, color, rough=0.8, metal=0.0, emit=None, emit_str=0.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit is not None:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emit_str
    MATS[name] = m
    return m


def add_bump(name, scale=22.0, detail=4.0, strength=0.22):
    m = MATS[name]
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tex = nt.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = scale
    tex.inputs["Detail"].default_value = detail
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    nt.links.new(tex.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])


def build_materials():
    mat("K_Floor", (0.115, 0.070, 0.042), rough=0.45)
    mat("K_Wall", (0.26, 0.21, 0.15), rough=0.95)
    mat("K_Wain", (0.14, 0.09, 0.055), rough=0.60)
    mat("K_WoodDark", (0.11, 0.065, 0.040), rough=0.55)
    mat("K_Ceiling", (0.20, 0.13, 0.075), rough=0.75)
    mat("K_Metal", (0.35, 0.30, 0.24), rough=0.35, metal=1.0)
    mat("K_Door", (0.30, 0.20, 0.12), rough=0.60)
    mat("K_Paper", (0.80, 0.74, 0.62), rough=0.90, emit=(1.00, 0.70, 0.36), emit_str=1.1)
    mat("K_Sign", (0.72, 0.63, 0.46), rough=0.75)
    mat("K_Lantern", (0.95, 0.70, 0.36), rough=0.65, emit=(1.00, 0.52, 0.20), emit_str=2.0)
    mat("K_LanternRib", (0.32, 0.09, 0.07), rough=0.70)
    mat("K_Glow", (1.0, 0.88, 0.68), rough=1.0, emit=(1.0, 0.70, 0.38), emit_str=2.6)
    hit = mat("K_Hit", (0.0, 0.0, 0.0), rough=1.0)
    hb = next(n for n in hit.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    hb.inputs["Alpha"].default_value = 0.0
    hit.blend_method = "BLEND"
    add_bump("K_Wall", scale=30.0, detail=6.0, strength=0.30)


# ---------------------------------------------------------------- 形の道具

CUBE_FACES = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
              (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]


def box(name, size, center, material=None):
    sx, sy, sz = (s * 0.5 for s in size)
    v = [(-sx, -sy, -sz), (sx, -sy, -sz), (sx, sy, -sz), (-sx, sy, -sz),
         (-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], CUBE_FACES)
    me.update()
    ob = bpy.data.objects.new(name, me)
    ob.location = center
    if material:
        ob.data.materials.append(MATS[material])
    return link(ob)


def quad(name, size, center, material=None):
    """UV 0..1 を持つ板。-Y を向く（マスの内側から見える向き）。"""
    w, h = size
    v = [(-w * 0.5, 0.0, -h * 0.5), (w * 0.5, 0.0, -h * 0.5),
         (w * 0.5, 0.0, h * 0.5), (-w * 0.5, 0.0, h * 0.5)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], [(0, 1, 2, 3)])
    me.update()
    uv = me.uv_layers.new(name="UVMap")
    for i, c in enumerate(((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))):
        uv.data[i].uv = c
    ob = bpy.data.objects.new(name, me)
    ob.location = center
    if material:
        ob.data.materials.append(MATS[material])
    return link(ob)


def cyl(name, radius, height, center, material=None, verts=14, rot=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    vs, fs = [], []
    hh = height * 0.5
    for z in (-hh, hh):
        for i in range(verts):
            a = 2.0 * math.pi * i / verts
            vs.append((radius * math.cos(a), radius * math.sin(a), z))
    for i in range(verts):
        j = (i + 1) % verts
        fs.append((i, j, j + verts, i + verts))
    fs.append(tuple(range(verts - 1, -1, -1)))
    fs.append(tuple(range(verts, verts * 2)))
    me.from_pydata(vs, [], fs)
    me.update()
    for poly in me.polygons[:verts]:
        poly.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    ob.location = center
    ob.rotation_euler = rot
    if material:
        ob.data.materials.append(MATS[material])
    return link(ob)


def tube(name, r_profile, height, center, material=None, verts=16):
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
            a0, b0 = k * verts + i, k * verts + j
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


def join_group(objects, target_name):
    """差し替えない部分は1つに統合する。マスの数だけ並ぶので、
    オブジェクト数がそのまま描画回数に効く。"""
    objects = [o for o in objects if o is not None]
    if not objects:
        return None
    if len(objects) > 1:
        view = bpy.context.view_layer
        for o in view.objects:
            o.select_set(False)
        for o in objects:
            o.select_set(True)
        view.objects.active = objects[0]
        with bpy.context.temp_override(active_object=objects[0], object=objects[0],
                                       selected_editable_objects=objects):
            bpy.ops.object.join()
    ob = objects[0]
    ob.name = target_name
    ob.data.name = target_name
    return ob


def zero_origin(ob):
    """原点をマスの中心へ寄せる。ここがずれていると、辺ごとに回して置いたときに
    とんでもない位置へ飛ぶ。"""
    off = ob.location.copy()
    for v in ob.data.vertices:
        v.co += off
    ob.location = (0.0, 0.0, 0.0)
    return ob


# ---------------------------------------------------------------- 部品

def build_core():
    """どのマスにも置く床・天井・隅柱・梁。"""
    parts = [
        box("Core_Floor", (CELL, CELL, 0.10), (0.0, 0.0, -0.05), "K_Floor"),
        box("Core_Ceiling", (CELL, CELL, 0.10), (0.0, 0.0, CORR_H + 0.05), "K_Ceiling"),
        # 隅柱は +X+Y の1本だけ。
        # ※「残り3隅は隣のマスの柱が埋める」と書いてあったが**埋まらない**。
        #   隣の柱は1マスぶん先の隅を埋めるだけで、どの角も 1/4 しか塞がらない。
        #   いまは corridor-view.js が読み込み時にこの箱を切り出し、四隅へ置き直している。
        #   寸法・位置を変えると向こうの POST_BOX の検証に引っかかって例外になる。
        box("Core_Post", (POST, POST, CORR_H), (HW + POST * 0.5, HW + POST * 0.5, CORR_H * 0.5),
            "K_WoodDark"),
        # 天井の梁も +X / +Y の辺だけ。両側に置くと隣と二重になる。
        box("Core_Beam_Y", (CELL, 0.10, 0.09), (0.0, HC, CORR_H - 0.045), "K_WoodDark"),
        box("Core_Beam_X", (0.10, CELL, 0.09), (HC, 0.0, CORR_H - 0.045), "K_WoodDark"),
    ]
    return zero_origin(join_group(parts, "Kit_Core"))


def build_wall():
    """扉の無い壁。塞ぐ辺のうち、扉を出さないところに置く。"""
    parts = [
        box("Wall_Panel", (CORR_W, WALL_T, CORR_H), (0.0, HW + WALL_T * 0.5, CORR_H * 0.5),
            "K_Wall"),
        box("Wall_Base", (CORR_W, 0.025, 0.09), (0.0, HW - 0.012, 0.045), "K_Wain"),
    ]
    return zero_origin(join_group(parts, "Kit_Wall"))


def build_door():
    """扉つきの壁。卓ごとに差し替える面だけ、子オブジェクトとして分けて残す。"""
    y_wall = HW + WALL_T * 0.5      # 壁の中心
    side_w = (CORR_W - DOOR_W) * 0.5

    statics = [
        box("D_Wall_L", (side_w, WALL_T, CORR_H),
            (-(DOOR_W + side_w) * 0.5, y_wall, CORR_H * 0.5), "K_Wall"),
        box("D_Wall_R", (side_w, WALL_T, CORR_H),
            ((DOOR_W + side_w) * 0.5, y_wall, CORR_H * 0.5), "K_Wall"),
        box("D_Wall_Over", (DOOR_W, WALL_T, CORR_H - DOOR_H),
            (0.0, y_wall, (DOOR_H + CORR_H) * 0.5), "K_Wall"),
        box("D_Shikii", (DOOR_W + 0.10, WALL_T, 0.04), (0.0, y_wall, 0.0), "K_WoodDark"),
        box("D_Kamoi", (DOOR_W + 0.10, WALL_T + 0.02, 0.10), (0.0, y_wall, DOOR_H + 0.05),
            "K_WoodDark"),
    ]
    for s in (-1, 1):
        statics.append(box(f"D_Jamb_{s}", (0.06, WALL_T + 0.02, DOOR_H),
                           (s * (DOOR_W * 0.5 + 0.03), y_wall, DOOR_H * 0.5), "K_WoodDark"))
        statics.append(box(f"D_Base_{s}", (side_w, 0.025, 0.09),
                           (s * (DOOR_W + side_w) * 0.5, HW - 0.012, 0.045), "K_Wain"))

    # 引き戸。開口の中に少し引っ込めて納める。
    y_door = HW + 0.055
    y_frame = HW + 0.042
    y_kumiko = HW + 0.030
    for s in (-1, 1):
        statics.append(box(f"D_Stile_{s}", (0.055, 0.028, DOOR_H - 0.03),
                           (s * (DOOR_W * 0.5 - 0.037), y_frame, DOOR_H * 0.5), "K_Door"))
        statics.append(box(f"D_Rail_{s}", (DOOR_W - 0.02, 0.028, 0.055),
                           (0.0, y_frame, DOOR_H * 0.5 + s * (DOOR_H * 0.5 - 0.04)), "K_Door"))
    for i in range(2):
        statics.append(box(f"D_Kumiko_V{i}", (0.016, 0.022, DOOR_H - 0.10),
                           (-DOOR_W * 0.5 + (i + 1) * DOOR_W / 3.0, y_kumiko, DOOR_H * 0.5),
                           "K_Door"))
    for j in range(3):
        statics.append(box(f"D_Kumiko_H{j}", (DOOR_W - 0.10, 0.022, 0.014),
                           (0.0, y_kumiko, 0.10 + (j + 1) * (DOOR_H - 0.20) / 4.0), "K_Door"))
    statics.append(box("D_Pull", (0.070, 0.010, 0.10), (DOOR_W * 0.30, HW + 0.020, 0.95),
                       "K_Metal"))

    # 木札の台と、提灯を吊る腕木
    statics.append(box("D_SignBoard", (0.44, 0.024, 0.60), (0.75, HW - 0.012, 1.42),
                       "K_WoodDark"))
    statics.append(box("D_LanternArm", (0.020, 0.24, 0.020), (-0.75, HW - 0.12, 1.98),
                       "K_WoodDark"))

    static = join_group(statics, "Door_Static")

    # 卓ごとに差し替える面
    paper = box("Door_Paper", (DOOR_W - 0.02, 0.012, DOOR_H - 0.03),
                (0.0, y_door, DOOR_H * 0.5), "K_Paper")
    sign = quad("Door_Sign", (0.38, 0.52), (0.75, HW - 0.026, 1.42), "K_Sign")
    lantern = tube("Door_Lantern",
                   [(0.0, 0.034), (0.18, 0.078), (0.55, 0.096), (0.86, 0.074), (1.0, 0.034)],
                   0.24, (-0.75, HW - 0.24, 1.80), "K_Lantern", verts=14)
    hit = quad("Door_Hit", (DOOR_W, DOOR_H), (0.0, HW - 0.006, DOOR_H * 0.5), "K_Hit")

    empty = bpy.data.objects.new("Kit_Door", None)
    empty.empty_display_size = 0.3
    link(empty)
    for child in (static, paper, sign, lantern, hit):
        child.parent = empty
    return empty


def build_pendant():
    parts = [
        cyl("P_Cord", 0.007, 0.30, (0.0, 0.0, CORR_H - 0.15), "K_WoodDark", verts=8),
        tube("P_Shade", [(0.0, 0.140), (0.35, 0.128), (1.0, 0.055)], 0.17,
             (0.0, 0.0, CORR_H - 0.385), "K_Ceiling", verts=16),
        cyl("P_Glow", 0.118, 0.02, (0.0, 0.0, CORR_H - 0.465), "K_Glow", verts=16),
    ]
    return zero_origin(join_group(parts, "Kit_Pendant"))


# ---------------------------------------------------------------- 確認用の組み立て

# 辺を回して置くときの角度。部品は +Y 側を塞ぐ形で作ってある。
DIR_ANGLE = {"N": 0.0, "E": -math.pi / 2, "S": math.pi, "W": math.pi / 2}
DIR_STEP = {"N": (0, 1), "E": (1, 0), "S": (0, -1), "W": (-1, 0)}

# 直線・角・T字・十字・行き止まりが1枚に入る見本。
# 値は「開いている辺」。隣り合うマスで辺の開き方が食い違うと壁が片側だけになる。
SAMPLE = {
    (0, 0): "E",       # 行き止まり
    (1, 0): "WEN",     # T字路
    (2, 0): "WENS",    # 十字路
    (3, 0): "WN",      # 角
    (2, -1): "N",      # 行き止まり
    (2, 1): "S",       # 行き止まり
    (1, 1): "SN",      # 直線
    (1, 2): "SE",      # 角
    (2, 2): "W",       # 行き止まり
    (3, 1): "S",       # 行き止まり
}


def instance(src, target_col, loc, rot_z=0.0, suffix=""):
    """部品を1つ置く。メッシュは共有するので、何個並べても増えるのは
    オブジェクトの箱だけ。子を持つ部品（扉）は子ごと連れていく。"""
    dup = src.copy()
    dup.name = src.name + suffix
    dup.location = loc
    dup.rotation_euler = (0.0, 0.0, rot_z)
    dup.hide_viewport = dup.hide_render = False
    target_col.objects.link(dup)
    for child in src.children:
        c = child.copy()
        c.name = child.name + suffix
        c.parent = dup
        c.hide_viewport = c.hide_render = False
        target_col.objects.link(c)
    return dup


def build_preview(layout=None):
    layout = SAMPLE if layout is None else layout
    col = bpy.data.collections.get(PREVIEW)
    if col:
        for ob in list(col.objects):
            bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.collections.remove(col)
    col = bpy.data.collections.new(PREVIEW)
    bpy.context.scene.collection.children.link(col)

    # 部品は原点にある。見本のマス (0,0) と重なるので、組み立て中は隠しておく。
    for ob in COL_OBJ.objects:
        ob.hide_viewport = ob.hide_render = True

    core = bpy.data.objects["Kit_Core"]
    wall = bpy.data.objects["Kit_Wall"]
    door = bpy.data.objects["Kit_Door"]
    pendant = bpy.data.objects["Kit_Pendant"]

    for (cx, cy), opens in layout.items():
        base = (cx * CELL, cy * CELL, 0.0)
        tag = f"__{cx}_{cy}"
        instance(core, col, base, 0.0, tag)
        if (cx + cy) % 2 == 0:
            instance(pendant, col, base, 0.0, tag)
        for i, d in enumerate("NESW"):
            if d in opens:
                continue          # 開いている辺には何も置かない＝通路になる
            # 塞ぐ辺のうち、扉を出すか素の壁にするかを散らす
            piece = wall if (cx + cy + i) % 3 == 0 else door
            instance(piece, col, base, DIR_ANGLE[d], f"{tag}_{d}")

    for (cx, cy) in layout:
        lamp = bpy.data.lights.new(f"Prev_Lamp_{cx}_{cy}", type="POINT")
        lamp.energy = 7.0
        lamp.color = (1.0, 0.76, 0.50)
        lamp.shadow_soft_size = 0.20
        ob = bpy.data.objects.new(f"Prev_Lamp_{cx}_{cy}", lamp)
        ob.location = (cx * CELL, cy * CELL, CORR_H - 0.55)
        col.objects.link(ob)

    data = bpy.data.cameras.new("Prev_Cam")
    data.lens = 20.0
    data.clip_start = 0.02
    cam = bpy.data.objects.new("Prev_Cam", data)
    cam.location = (-0.55, 0.12, 1.55)
    col.objects.link(cam)
    from mathutils import Vector
    d = Vector((3 * CELL, 0.0, 1.15)) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return col


def setup_scene():
    scene = bpy.context.scene
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    try:
        scene.eevee.use_raytracing = True
    except AttributeError:
        pass
    scene.view_settings.view_transform = "AgX"
    for look in ("AgX - Medium High Contrast", "AgX - Base Contrast", "None"):
        try:
            scene.view_settings.look = look
            break
        except TypeError:
            continue
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.02, 0.017, 0.014, 1.0)
        bg.inputs["Strength"].default_value = 1.0


# ---------------------------------------------------------------- 書き出し

def export_kit(path):
    """部品だけを GLB にする。確認用の組み立てとライトは含めない。"""
    for ob in COL_OBJ.objects:
        ob.hide_viewport = ob.hide_render = False
    bpy.ops.object.select_all(action="DESELECT")
    for ob in COL_OBJ.objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = next(iter(COL_OBJ.objects), None)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_apply=True,
        export_cameras=False, export_lights=False,
    )
    return path


# ---------------------------------------------------------------- 実行

def main(preview=True):
    global COL_OBJ
    COL_OBJ = reset()
    build_materials()
    build_core()
    build_wall()
    build_door()
    build_pendant()
    setup_scene()
    if preview:
        build_preview()
    tris = 0
    for ob in COL_OBJ.objects:
        if ob.type == "MESH":
            tris += sum(len(p.vertices) - 2 for p in ob.data.polygons)
    print(f"[IzakayaKit] cell {CELL}m / parts {len(COL_OBJ.objects)} / {tris} tris")
    return tris


if __name__ == "__main__":
    main()
