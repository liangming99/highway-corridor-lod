# build_bridge.py — 柳江二桥（双塔斜拉桥）构件级模型
# 实际尺寸（米），1 BU = 1 m。运行：
#   Blender -b -P build_bridge.py -- --out model.glb
import bpy, bmesh, math, sys, os
from mathutils import Vector, Matrix

argv = sys.argv
out = None
if "--" in argv:
    rest = argv[argv.index("--") + 1:]
    for i, a in enumerate(rest):
        if a == "--out" and i + 1 < len(rest):
            out = rest[i + 1]
if not out:
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge.glb")

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
COLL = bpy.context.collection
ASSET = "BR-0768"

# ── 材质 ─────────────────────────────────────────────────
def new_mat(name, color, rough=0.6, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m

MAT_CONCRETE = new_mat("concrete", (0.74, 0.73, 0.71), 0.88)
MAT_STEEL    = new_mat("steel_paint", (0.66, 0.68, 0.71), 0.38, 0.75)
MAT_DECK     = new_mat("asphalt", (0.17, 0.18, 0.19), 0.96)
MAT_CABLE    = new_mat("cable", (0.80, 0.81, 0.82), 0.28, 0.92)
MAT_MARK     = new_mat("road_marking", (0.94, 0.92, 0.82), 0.65)
MAT_RAIL     = new_mat("railing", (0.58, 0.60, 0.62), 0.35, 0.65)
MAT_PIER     = new_mat("pier_concrete", (0.68, 0.67, 0.65), 0.9)

def add_object(name, bm, mat, part):
    me = bpy.data.meshes.new(name + "_mesh")
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    COLL.objects.link(ob)
    if mat: ob.data.materials.append(mat)
    ob["asset"] = ASSET
    ob["part"] = part
    if not me.uv_layers: me.uv_layers.new(name="UVMap")
    return ob

def box(bm, cx, cy, cz, sx, sy, sz):
    vs = []
    for dx in (-0.5, 0.5):
        for dy in (-0.5, 0.5):
            for dz in (-0.5, 0.5):
                vs.append(bm.verts.new((cx+dx*sx, cy+dy*sy, cz+dz*sz)))
    for f in [(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)]:
        try: bm.faces.new([vs[i] for i in f])
        except ValueError: pass
    return vs

def loft(bm, rings, close_caps=True):
    """rings: 每层的矩形截面 [(cx, cy, cz, half_w, half_d)]，沿 z 放样"""
    layers = []
    for (cx, cy, cz, hw, hd) in rings:
        quad = [bm.verts.new((cx-hw, cy-hd, cz)), bm.verts.new((cx+hw, cy-hd, cz)),
                bm.verts.new((cx+hw, cy+hd, cz)), bm.verts.new((cx-hw, cy+hd, cz))]
        layers.append(quad)
    for i in range(len(layers)-1):
        a, b = layers[i], layers[i+1]
        for k in range(4):
            k2 = (k+1) % 4
            try: bm.faces.new([a[k], a[k2], b[k2], b[k]])
            except ValueError: pass
    if close_caps:
        try: bm.faces.new(list(reversed(layers[0])))
        except ValueError: pass
        try: bm.faces.new(layers[-1])
        except ValueError: pass
    return layers

def cyl(bm, cx, cy, cz, r, h, seg=16):
    rb, rt = [], []
    for i in range(seg):
        a = 2*math.pi*i/seg
        c, s = math.cos(a), math.sin(a)
        rb.append(bm.verts.new((cx+r*c, cy+r*s, cz)))
        rt.append(bm.verts.new((cx+r*c, cy+r*s, cz+h)))
    for i in range(seg):
        j = (i+1) % seg
        try: bm.faces.new([rb[i], rb[j], rt[j], rt[i]])
        except ValueError: pass
    try: bm.faces.new(list(reversed(rb)))
    except ValueError: pass
    try: bm.faces.new(rt)
    except ValueError: pass

def cable(bm, p0, p1, r, seg=8):
    p0, p1 = Vector(p0), Vector(p1)
    d = (p1 - p0); L = d.length
    if L < 1e-6: return
    dn = d.normalized()
    up = Vector((0,0,1)) if abs(dn.dot(Vector((0,0,1)))) < 0.95 else Vector((1,0,0))
    n1 = dn.cross(up).normalized(); n2 = dn.cross(n1).normalized()
    rb, rt = [], []
    for i in range(seg):
        a = 2*math.pi*i/seg
        off = n1*(math.cos(a)*r) + n2*(math.sin(a)*r)
        rb.append(bm.verts.new(p0+off)); rt.append(bm.verts.new(p1+off))
    for i in range(seg):
        j = (i+1) % seg
        try: bm.faces.new([rb[i], rb[j], rt[j], rt[i]])
        except ValueError: pass

# ── 主要尺寸（6 车道双塔斜拉桥）──────────────────────────
SPAN_MAIN = 420.0
SPAN_SIDE = 190.0
TOTAL = SPAN_MAIN + 2*SPAN_SIDE          # 800 m
DECK_W = 33.0
DECK_T = 3.2                             # 钢箱梁梁高
DECK_Z = 42.0                            # 桥面标高
PYLON_H = 145.0                          # 塔顶标高
CABLE_N = 15
parts = {}

# ── 1. 钢箱梁（含梁高与底板）─────────────────────────
bm = bmesh.new()
box(bm, 0, 0, DECK_Z - DECK_T/2, TOTAL, DECK_W, DECK_T)
# 底部纵向加劲肋
for i in range(-7, 8):
    box(bm, 0, i*2.1, DECK_Z - DECK_T - 0.35, TOTAL-6, 0.42, 0.7)
# 横隔板（每 15 m）
for k in range(int(-TOTAL/2)+8, int(TOTAL/2)-8, 15):
    box(bm, k, 0, DECK_Z - DECK_T/2 - 0.1, 0.5, DECK_W-2, DECK_T-0.4)
parts["girder"] = add_object("BR0768_girder", bm, MAT_STEEL, "主梁")

# ── 2. 桥面铺装 ────────────────────────────────────
bm = bmesh.new()
box(bm, 0, 0, DECK_Z + 0.08, TOTAL-2, DECK_W-1.6, 0.16)
parts["deck"] = add_object("BR0768_deck", bm, MAT_DECK, "桥面铺装")

# ── 3. 标线与中央分隔带 ─────────────────────────────
bm = bmesh.new()
for lane in (-2.5, -1.5, 1.5, 2.5):
    box(bm, 0, lane*3.4, DECK_Z + 0.18, TOTAL-24, 0.16, 0.04)
box(bm, 0, 0, DECK_Z + 0.32, TOTAL-24, 1.4, 0.5)
parts["markings"] = add_object("BR0768_markings", bm, MAT_MARK, "标线")

# ── 4. 防撞护栏 ────────────────────────────────────
bm = bmesh.new()
for side in (-1, 1):
    y = side*(DECK_W/2 - 0.5)
    box(bm, 0, y, DECK_Z + 0.85, TOTAL, 0.5, 1.1)
    box(bm, 0, y, DECK_Z + 1.55, TOTAL, 0.22, 0.22)
    for k in range(0, int(TOTAL), 4):
        box(bm, -TOTAL/2 + k, y, DECK_Z + 1.2, 0.14, 0.14, 0.6)
parts["railings"] = add_object("BR0768_railings", bm, MAT_RAIL, "防撞护栏")

# ── 5. A 形桥塔（变截面，两座）──────────────────────
for ti, tx in enumerate((-SPAN_MAIN/2, SPAN_MAIN/2)):
    bm = bmesh.new()
    # 每条塔腿：根部外张 → 顶部收拢，截面渐缩
    for side in (-1, 1):
        rings = []
        z0, z1 = DECK_Z - 6, PYLON_H
        steps = 14
        for s in range(steps+1):
            t = s/steps
            z = z0 + (z1 - z0)*t
            # 横向位置：根部 ±(W/2+5)，顶部 ±1.8（A 形收口）
            y = side*((DECK_W/2 + 5.0) + (1.8 - (DECK_W/2 + 5.0))*t)
            # 截面随高度收缩
            hw = 2.6*(1 - 0.45*t)
            hd = 4.2*(1 - 0.55*t)
            rings.append((tx, y, z, hw, hd))
        loft(bm, rings)
    # 上横梁（塔顶附近）与下横梁（桥面下）
    box(bm, tx, 0, PYLON_H - 8, 5.2, 9.0, 4.6)
    box(bm, tx, 0, DECK_Z + 24, 5.0, DECK_W*0.42, 4.0)
    box(bm, tx, 0, DECK_Z - 8, 6.0, DECK_W*0.62, 6.0)
    parts["pylon"+str(ti)] = add_object("BR0768_pylon"+"AB"[ti], bm, MAT_CONCRETE, "桥塔"+"AB"[ti])

# ── 6. 斜拉索（双索面扇形）──────────────────────────
bm = bmesh.new()
for ti, tx in enumerate((-SPAN_MAIN/2, SPAN_MAIN/2)):
    sign = 1 if tx < 0 else -1
    for side in (-1, 1):
        y_deck = side*(DECK_W/2 - 2.2)
        for i in range(CABLE_N):
            t = (i+1)/CABLE_N
            z_top = DECK_Z + 30 + (PYLON_H - DECK_Z - 42)*t
            y_top = side*((DECK_W/2 + 5.0) + (1.8 - (DECK_W/2 + 5.0))*((z_top-(DECK_Z-6))/(PYLON_H-(DECK_Z-6))))
            # 主跨
            x_m = tx + sign*(SPAN_MAIN/2 - 10)*t
            cable(bm, (tx, y_top, z_top), (x_m, y_deck, DECK_Z + 1.0), 0.17, 8)
            # 边跨
            x_s = tx - sign*(SPAN_SIDE - 16)*t
            cable(bm, (tx, y_top, z_top), (x_s, y_deck, DECK_Z + 1.0), 0.17, 8)
parts["cables"] = add_object("BR0768_cables", bm, MAT_CABLE, "斜拉索")

# ── 7. 辅助墩（边跨）与基础 ─────────────────────────
bm = bmesh.new()
for px in (-SPAN_MAIN/2 - 95, SPAN_MAIN/2 + 95):
    box(bm, px, 0, DECK_Z - 16, 9, DECK_W*0.5, 26)
    box(bm, px, 0, 3.0, 18, DECK_W*0.75, 6.0)
# 主塔承台
for tx in (-SPAN_MAIN/2, SPAN_MAIN/2):
    box(bm, tx, 0, 3.0, 44, 46, 8.0)
    for side in (-1, 1):
        cyl(bm, tx, side*13, 6.0, 3.2, 16, 12)   # 桩基示意
parts["piers"] = add_object("BR0768_piers", bm, MAT_PIER, "桥墩与基础")

# ── 8. 桥台 ───────────────────────────────────────
bm = bmesh.new()
for xx in (-TOTAL/2 - 8, TOTAL/2 + 8):
    box(bm, xx, 0, DECK_Z - 10, 16, DECK_W + 8, 20)
parts["abutments"] = add_object("BR0768_abutments", bm, MAT_CONCRETE, "桥台")

# ── 根物体 ────────────────────────────────────────
root_ob = bpy.data.objects.new("BR-0768 柳江二桥", None)
COLL.objects.link(root_ob)
for ob in parts.values():
    ob.parent = root_ob

tris = 0
for ob in parts.values():
    ob.data.calc_loop_triangles(); tris += len(ob.data.loop_triangles)

os.makedirs(os.path.dirname(out), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=False,
                          export_apply=True, export_yup=True, export_materials='EXPORT')
print("EXPORTED", out)
print("PARTS", len(parts), "TRIS", tris)
