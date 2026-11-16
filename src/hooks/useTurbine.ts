import { nextTick, ref, reactive } from 'vue'
import { forEach, random } from 'lodash-es'
import useThree from './useThree'
import TWEEN from 'three/examples/jsm/libs/tween.module.js'
import * as THREE from 'three'
import WidgetLabel from '@/components/WidgetLabel.vue'

// ==========================================
// 1. 全局配置层：数据与状态分离（数据驱动）
// ==========================================
const CONFIG = {
  // 模型文件的 API 路径（通过环境变量注入）
  MODEL_SOURCES: {
    EQUIPMENT: `${import.meta.env.VITE_API_DOMAIN}/models/equipment.glb`,
    PLANE: `${import.meta.env.VITE_API_DOMAIN}/models/plane.glb`,
    SKELETON: `${import.meta.env.VITE_API_DOMAIN}/models/skeleton.glb`,
  },
  // 模型全局缩放比例（原模型太大，缩小至 0.0003）
  MODEL_SCALES: [0.0001 * 3, 0.0001 * 3, 0.0001 * 3],
  // 核心配置：9个核心零部件的三维坐标
  EQUIPMENT_POSITION: {
    变桨系统: {
      LABEL: { x: 0.0291, y: 2.6277, z: 0.2308 }, // 3D空间标签的坐标（受缩放影响，较小）
      COMPOSE: { x: 2519.0795, y: 29288.6777, z: 0 }, // 初始组装状态的坐标（模型原始坐标系）
      DECOMPOSE: { x: 2519.0795, y: 29000.6777, z: 300 }, // 拆解爆炸后的坐标（向外延伸）
    },
    // ... 其他零部件（转子、主轴、齿轮箱等）的坐标配置同理
  },
} as const // as const 保证配置对象在 TS 中为只读，防止被意外修改

// ==========================================
// 2. 核心逻辑层：Composition API 封装
// ==========================================
export function useTurbine() {
  // 从 useThree（底层的 Three.js 封装 hook）解构出所需的核心对象和方法
  const {
    container, // 挂载 3D 画布的 DOM 容器 (ref)
    scene, // 3D 场景 (ref)
    camera, // 相机 (ref)
    ocontrol, // 轨道控制器 OrbitControls (ref)
    outlinePass, // 后期处理：选中描边特效
    hexPass, // 后期处理：悬浮高亮特效
    loadGltf, // 封装好的 GLTF 模型加载函数
    loadAnimationMixer, // 封装好的骨骼动画/模型内置动画播放函数
    loadCSS2DByVue, // 封装好的将 Vue 组件转为 3D 空间 CSS2D 标签的工具
    addModelPick, // 鼠标点击射线拾取
    addModelHoverPick, // 鼠标悬浮射线拾取
    transitionAnimation, // 封装好的基于 TWEEN 的通用动画过渡函数
    planeClippingAnimation, // 封装好的平面削切动画（利用 Three.js 的 clippingPlanes）
  } = useThree()

  // 响应式状态：记录当前选中的零部件名称（用于联动右侧的 Vue 面板）
  const current = ref('')
  // 状态锁：防止在动画执行期间用户重复触发动画
  const isAnimation = ref(false)

  // 3D 对象：标签组（统一管理所有漂浮的 3D HTML 标签）
  const labelGroup = new THREE.Group()

  // 存放加载后的模型
  const models = {
    equipment: null as any, // 内部机械零件
    plane: null as any,     // 机舱外壳（带颜色）
    skeleton: null as any,  // 机舱骨架（线框）
  }

  // 提取外壳骨架中的特定子对象
  const skeletons = {
    color: null as any,     // 颜色材质外壳
    wireframe: null as any, // 线框材质外壳
  }

  // 响应式加载状态：用于给外层的 <LayoutLoading> 组件显示进度
  const loading = reactive({
    total: 2, // 总共加载 2 个模型：equipment 和 skeleton
    loaded: 0,
    isLoading: true,
  })

  // ==========================================
  // 3. 初始化流程：启动引擎
  // ==========================================
  const boostrap = async () => {
    await loadModels() // 第一步：异步加载模型
    loadLights()      // 第二步：配置场景光照
    await openingAnimation() // 第三步：执行开场动画（等待其完成）

    // 第四步：绑定交互事件（只有在开场动画结束后才允许交互）
    // 1. 绑定点击事件：如果点中设备，更新 current 变量，激活描边特效
    addModelPick(models.equipment, (intersects) => {
      if (intersects.length > 0) {
        const obj = intersects[0]['object']
        current.value = obj.name // 通知 Vue 面板
        outlinePass.value!.selectedObjects = [obj] // 开启描边发光
      } else {
        // 点击空白处，清空选中
        current.value = ''
        outlinePass.value!.selectedObjects = []
      }
    })
    // 2. 绑定鼠标悬浮事件：激活高亮特效
    addModelHoverPick(models.equipment, (intersects) => {
      if (intersects.length > 0) {
        const obj = intersects[0]['object']
        hexPass.value!.selectedObjects = [obj] // 悬浮高亮
      } else {
        hexPass.value!.selectedObjects = []
      }
    })
  }

  // ------------------------------------------
  // 3.1 加载模型
  // ------------------------------------------
  const loadModels = async () => {
    // 封装加载内部零件（equipment）的异步函数
    const loadEquipment = async () => {
      const gltf = await loadGltf(CONFIG.MODEL_SOURCES.EQUIPMENT)
      const model = gltf.scene
      model.scale.set(...CONFIG.MODEL_SCALES) // 设置缩放
      models.equipment = model
      loading.loaded += 1 // 进度 +1
      model.name = 'equipment'
      scene.value!.add(model) // 添加到场景
    }
    
    // 封装加载外壳骨架（skeleton）的异步函数
    const loadSkeleton = async () => {
      const gltf = await loadGltf(CONFIG.MODEL_SOURCES.SKELETON)
      const model = gltf.scene
      // 重点：模型自带内置动画，直接启动它（比如风机旋转）
      loadAnimationMixer(model, gltf.animations, gltf.animations[0].name)
      model.scale.set(...CONFIG.MODEL_SCALES)
      models.skeleton = model
      loading.loaded += 1
      model.name = 'skeleton'
      scene.value!.add(model)
      
      // 通过名称在模型层级中精准找到外壳的两种材质
      skeletons.color = models.skeleton.getObjectByName('颜色材质')
      skeletons.wireframe = models.skeleton.getObjectByName('线框材质')
    }
    
    // 并发加载，提升速度
    await Promise.all([loadEquipment(), loadSkeleton()])
    loading.isLoading = false // 隐藏加载遮罩
    loading.loaded = 2
  }

  // ------------------------------------------
  // 3.2 加载灯光
  // ------------------------------------------
  const loadLights = () => {
    // 定义了四个不同方向的点，模拟全局环境光
    const LIGHT_LIST = [
      [0, 0, 0],
      [-100, 100, 100],
      [100, -100, 100],
      [100, 100, -100],
    ]
    forEach(LIGHT_LIST, ([x, y, z]) => {
      const directionalLight = new THREE.DirectionalLight(0xffffff, 5) // 白色平行光，强度为 5
      directionalLight.position.set(x, y, z)
      scene.value?.add(directionalLight)
    })
  }

  // ==========================================
  // 4. 动画流程：开场、拆解、组合
  // ==========================================
  
  // 4.1 开场动画
  const openingAnimation = () => {
    return new Promise((resolve) => {
      isAnimation.value = true
      
      // 动画 A：外壳削切消失（从位置 4 切到 2）
      planeClippingAnimation({
        objects: [skeletons.color!],
        from: 4,
        to: 2,
        during: 1000 * 4, // 耗时 4 秒
        onComplete() {
          skeletons.color!.visible = false // 削切完毕，彻底隐藏该材质
        },
      }).start()
      
      // 动画 B：相机镜头缓慢推进到指定视角
      transitionAnimation({
        from: camera.value!.position,
        to: { x: 0.5, y: 2.8, z: 0.5 }, // 最佳观赏坐标
        duration: 1000 * 2,
        easing: TWEEN.Easing.Quintic.InOut, // 缓动函数：先快后慢
        onUpdate: ({ x, y, z }: any) => {
          camera.value!.position.set(x, y, z) // 逐帧更新相机位置
          ocontrol.value?.update() // 更新控制器
        },
        onComplete() {
          isAnimation.value = false
          resolve(void 0) // 通知外部：开场动画结束
        },
      }).start()
    })
  }

  // 4.2 设备拆解动画（核心）
  const eqDecomposeAnimation = () => {
    return new Promise((resolve) => {
      skeletons.color.visible = false // 确保白色外壳隐藏
      isAnimation.value = true

      // 动画 1：线框外壳削切消失
      const skeletonAnimate = planeClippingAnimation({
        objects: [skeletons.wireframe],
        from: 4,
        to: 2,
        during: 1000 * 2,
        onComplete: () => {
          skeletons.wireframe.visible = false
          cameraAnimate.start() // 注意：削切完毕后，启动相机动画
        },
      })

      // 组装动画的起点和终点数据
      const from: any = {}
      const to: any = {}
      
      // 遍历所有零件，提取初始坐标和拆解坐标
      forEach(models.equipment.children, (mesh, index) => {
        const name = mesh.name as keyof typeof CONFIG.EQUIPMENT_POSITION
        const decompose = CONFIG.EQUIPMENT_POSITION[name]['DECOMPOSE']
        const compose = CONFIG.EQUIPMENT_POSITION[name]['COMPOSE']
        // 使用 x0, y0, z0 动态拼接属性名，将多个零件的坐标合并到一个大对象中，方便用一个 TWEEN 统一管理
        from[`x${index}`] = compose.x
        from[`y${index}`] = compose.y
        from[`z${index}`] = compose.z
        to[`x${index}`] = decompose.x
        to[`y${index}`] = decompose.y
        to[`z${index}`] = decompose.z
      })

      // 动画 2：所有零件向外飞散（爆炸图效果）
      const eqAnimate = transitionAnimation({
        from,
        to,
        duration: 1000 * 2,
        easing: TWEEN.Easing.Quintic.InOut,
        onUpdate(data) {
          // 逐帧更新每个零件的坐标
          forEach(models.equipment.children, (mesh, index) => {
            mesh.position.set(
              data[`x${index}`],
              data[`y${index}`],
              data[`z${index}`]
            )
          })
        },
        onComplete: () => {
          isAnimation.value = false
          createEquipmentLabel() // 动画结束，生成 3D 标签
          resolve(void 0)
        },
      })

      // 动画 3：相机稍微拉远，以便看清拆解后的全貌
      const cameraAnimate = transitionAnimation({
        from: camera.value!.position,
        to: { x: 0.7, y: 2.8, z: 0 },
        duration: 1000 * 2,
        easing: TWEEN.Easing.Linear.None,
        onUpdate(data) {
          camera.value!.position.set(data.x, data.y, data.z)
          ocontrol.value?.update()
        },
      })
      
      // 使用 TWEEN 的链式调用：先执行削切，再执行零件飞散
      skeletonAnimate.chain(eqAnimate).start()
    })
  }

  // 4.3 设备组合动画（与拆解正好相反）
  const eqComposeAnimation = () => {
    return new Promise((resolve) => {
      isAnimation.value = true
      removeEquipmentLabel() // 1. 先移除标签

      // 相机拉近
      const cameraAnimate = transitionAnimation({
        from: camera.value!.position,
        to: { x: 0.5, y: 2.8, z: 0.5 },
        duration: 1000 * 2,
        easing: TWEEN.Easing.Linear.None,
        onUpdate(data) {
          camera.value!.position.set(data.x, data.y, data.z)
          ocontrol.value?.update()
        },
      })
      cameraAnimate.start()

      // 组装起止数据（与拆解相反：从 DECOMPOSE 回到 COMPOSE）
      const from: any = {}
      const to: any = {}
      forEach(models.equipment.children, (mesh, index) => {
        const name = mesh.name as keyof typeof CONFIG.EQUIPMENT_POSITION
        const decompose = CONFIG.EQUIPMENT_POSITION[name]['DECOMPOSE']
        const compose = CONFIG.EQUIPMENT_POSITION[name]['COMPOSE']
        from[`x${index}`] = decompose.x
        from[`y${index}`] = decompose.y
        from[`z${index}`] = decompose.z
        to[`x${index}`] = compose.x
        to[`y${index}`] = compose.y
        to[`z${index}`] = compose.z
      })

      // 零件飞回原位
      const eqAnimate = transitionAnimation({
        from, to, duration: 1000 * 2, easing: TWEEN.Easing.Quintic.InOut,
        onUpdate(data) {
          forEach(models.equipment.children, (mesh, index) => {
            mesh.position.set(data[`x${index}`], data[`y${index}`], data[`z${index}`])
          })
        },
      })
      
      skeletons.wireframe.visible = true // 线框外壳恢复显示
      
      // 外壳闭合动画（从 2 切到 4）
      const skeletonAnimate = planeClippingAnimation({
        objects: [skeletons.wireframe],
        from: 2,
        to: 4,
        during: 1000 * 2,
        onComplete: () => {
          isAnimation.value = false
          resolve(void 0)
        },
      })
      
      // 链式调用：零件先归位，归位后外壳再出现闭合
      eqAnimate.chain(skeletonAnimate).start()
    })
  }

  // ==========================================
  // 5. 标签管理与告警逻辑
  // ==========================================

  // 生成设备标签（将 Vue 组件渲染到 3D 空间）
  const createEquipmentLabel = () => {
    forEach(CONFIG.EQUIPMENT_POSITION, (point, name) => {
      // 使用封装的工具，实例化 Vue 组件并转换成 3D 对象
      const label = loadCSS2DByVue(WidgetLabel, { name })
      label.position.set(point.LABEL.x, point.LABEL.y, point.LABEL.z)
      labelGroup.add(label) // 加入标签组
    })
    scene.value!.add(labelGroup) // 组加入场景
  }

  // 移除设备标签（极其重要的性能优化：防止内存泄漏）
  const removeEquipmentLabel = () => {
    while (labelGroup.children.length > 0) {
      const child: any = labelGroup.children[0]
      labelGroup.remove(child)
      // 显式销毁几何体和材质，释放 GPU 显存
      child.geometry && child.geometry.dispose()
      child.material && child.material.dispose()
    }
    scene.value!.remove(labelGroup)
  }

  const warningTimer = ref() // 定时器句柄

  // 开始模拟设备告警
  const startWarning = () => {
    // 备份材质颜色，避免多个物体共享材质导致全局变色
    models.equipment.children.forEach((mesh: any) => {
      mesh.material = mesh.material.clone() 
      mesh.hex = mesh.material.emissive.getHex() // 记录原始自发光颜色
    })

    const handle = () => {
      // 随机挑选一个零件
      const currentIndex = random(0, models.equipment.children.length - 1)
      models.equipment.children.forEach((mesh: any, index: number) => {
        if (index === currentIndex) {
          mesh.material.emissive.setHex(0xff0000) // 选中的变红
        } else {
          mesh.material.emissive.setHex(mesh.hex) // 没选中的恢复原色
        }
      })
      
      // 相机转动（模拟巡逻扫视）
      transitionAnimation({
        from: camera.value!.position,
        to: { x: 0.7, y: 2.8, z: 0 },
        duration: 1000 * 2,
        easing: TWEEN.Easing.Linear.None,
        onUpdate(data) {
          camera.value!.position.set(data.x, data.y, data.z)
          ocontrol.value?.update()
        },
      }).start()
    }
    
    handle() // 立即执行一次
    warningTimer.value = setInterval(handle, 1000 * 2) // 每 2 秒循环一次
  }

  // 结束模拟设备告警
  const stopWarning = () => {
    clearInterval(warningTimer.value) // 清除定时器
    models.equipment.children.forEach((mesh: any) => {
      mesh.material.emissive.setHex(mesh.hex) // 恢复所有零件的颜色
    })
    
    // 相机复位
    transitionAnimation({
      from: camera.value!.position,
      to: { x: 0.5, y: 2.8, z: 0.5 },
      duration: 1000 * 2,
      easing: TWEEN.Easing.Linear.None,
      onUpdate(data) {
        camera.value!.position.set(data.x, data.y, data.z)
        ocontrol.value?.update()
      },
    }).start()
  }

  // ==========================================
  // 6. 启动执行 & 暴露接口
  // ==========================================
  // nextTick 确保 Vue 组件挂载完毕，DOM 渲染完成后再执行 Three.js 初始化
  nextTick(async () => {
    await boostrap()
  })

  // 暴露给 Vue 组件调用的接口
  return {
    container, // 挂载点
    loading,   // 加载状态
    current,   // 当前选中零件名（用于右侧面板渲染）
    eqDecomposeAnimation, // 外部触发的拆解动作
    eqComposeAnimation,   // 外部触发的组合动作
    startWarning,         // 开启告警
    stopWarning,          // 关闭告警
  }
}

export default useTurbine