---
title: Go语言之Map旧版本
date: 2025-09-02 08:40:50
tags: Go
---

## Go1.24之前的map原理

### 一、map结构

Go语言Map的结构：

```go
// Maximum number of key/elem pairs a bucket can hold.
bucketCntBits = 3
bucketCnt     = 1 << bucketCntBits//每个桶中元素个数为8

// Represent as loadFactorNum/loadFactorDen, to allow integer math.
loadFactorNum = 13
loadFactorDen = 2 //13除以2得到负载因子 6.5
// flags
iterator     = 1 // there may be an iterator using buckets
oldIterator  = 2 // there may be an iterator using oldbuckets
hashWriting  = 4 // a goroutine is writing to the map
sameSizeGrow = 8 // the current map growth is to a new map of the same size
// A header for a Go map.
type hmap struct {
	count     int //map中键值对个数 ，len(map)就是取的该值
	flags     uint8 //标志位，用于表示当前map正在写等状态
	B         uint8  // 2^B表示map中桶的个数
	noverflow uint16 // 溢出桶的个数,其只表示实时申请的溢出桶个数，不包含预申请的溢出桶。approximate number of overflow buckets; see incrnoverflow for details
	hash0     uint32 // hash seed
	buckets    unsafe.Pointer // 桶数组。array of 2^B Buckets. may be nil if count==0.
	oldbuckets unsafe.Pointer // 扩容时用，暂存旧的桶。previous bucket array of half the size, non-nil only when growing
	nevacuate  uintptr        // 表示扩容时迁移进度，小于该值的表示已经被迁移了。progress counter for evacuation (buckets less than this have been evacuated)
	extra *mapextra // optional fields
}
// mapextra holds fields that are not present on all maps.
//overflow与nextOverflow没有任何从属关系
type mapextra struct {
	overflow    *[]*bmap //等nextOverflow没有时，插入时又需要溢出桶，此时申请的溢出桶就放在这里，可称之为实时申请的溢出桶
	oldoverflow *[]*bmap //扩容时旧的溢出桶
	// nextOverflow holds a pointer to a free overflow bucket.
	nextOverflow *bmap //预申请的溢出桶，在map初始化的时候确定，与h.buckets属于同一块连续内存
}
// 桶内部结构
type bmap struct {
	tophash [bucketCnt]uint8//tophash的元素是取key的hash值的高8位，用于快速定位key的位置
	key[bucketCnt]unsafe.Pointer//连续的key,便于内存对齐以节省空间
	value[bucketCnt]unsafe.Pointer//连续的value,便于内存对齐以节省空间
	overflow    *bmap //溢出桶指针
}
```

bmap中的key,value,overflow类型没有显式定义，而是通过指针运算来访问。

大多数的map操作函数都是以maptype类型作为第一个参数，maptype类型定义：

```go
type maptype struct {
	typ    _type//map类型
	key    *_type //key类型
	elem   *_type //value类型
	bucket *_type // internal type representing a hash bucket
	// function for hashing keys (ptr to key, seed) -> hash
	hasher     func(unsafe.Pointer, uintptr) uintptr //hsah函数
	keysize    uint8  // size of key slot
	elemsize   uint8  // size of elem slot
	bucketsize uint16 // size of bucket，即bmap大小
	flags      uint32
}
```

maptype类型中有key，value类型大小还有hash函数。

![map结构图](/img/go-map.png)

从上面可以看出，对于hash冲突，map是采用拉链法(溢出桶)来解决hash冲突。

### 二、map的初始化

我们在make函数初始化的时候，可以分为不带容量初始化和带容量初始化。

#### 1、不带容量初始化

不带容量初始化比较简单，调用makemap_small，如下：

```go
func makemap_small() *hmap {
	h := new(hmap)
	h.hash0 = fastrand()//生成hash种子
	return h
}
```

可以看到只是初始化了一个hmap类型的指针，并没有申请其它内存。

#### 2、带容量初始化

带容量初始化的时候如果容量类型是int64,会调用makemap64函数，如下：

```go
func makemap64(t *maptype, hint int64, h *hmap) *hmap {
	if int64(int(hint)) != hint {
		hint = 0
	}
	return makemap(t, int(hint), h)
}
```

否则直接调用makemap函数：

```go
//hint 是make是定义的map的键值对个数，比如make(map[int]bool,111),那么hint就是111
func makemap(t *maptype, hint int, h *hmap) *hmap {
	mem, overflow := math.MulUintptr(uintptr(hint), t.bucket.size)
	if overflow || mem > maxAlloc {
		hint = 0
	}
	// initialize Hmap
	if h == nil {
		h = new(hmap)
	}
	h.hash0 = fastrand()//生成hash种子
	// Find the size parameter B which will hold the requested # of elements.
	// For hint < 0 overLoadFactor returns false since hint < bucketCnt.
	B := uint8(0)
	for overLoadFactor(hint, B) {//根据hint值计算B的大小，即桶个数
		B++ //如果此时超过负载因子，B就加1
	}
	h.B = B
	// if B == 0, the buckets field is allocated lazily later (in mapassign)
	// If hint is large zeroing this memory could take a while.
	if h.B != 0 {
		var nextOverflow *bmap
		h.buckets, nextOverflow = makeBucketArray(t, h.B, nil)//申请桶和溢出桶内存
		if nextOverflow != nil {
			h.extra = new(mapextra)
			h.extra.nextOverflow = nextOverflow
		}
	}
	return h
}

func makeBucketArray(t *maptype, b uint8, dirtyalloc unsafe.Pointer) (buckets unsafe.Pointer, nextOverflow *bmap) {
	base := bucketShift(b)//计算桶个数，2^B
	nbuckets := base
	//对于map键值对个数较少时并不会申请溢出桶，避免计算开销
	if b >= 4 {//只有b>=4时才会按照2^(b-4来申请溢出桶个数
		nbuckets += bucketShift(b - 4)
		sz := t.bucket.size * nbuckets
		up := roundupsize(sz)//内存对齐
		if up != sz {
			nbuckets = up / t.bucket.size//得出内存对齐后的所有桶个数
		}
	}
  //申请一段连续内存（包括正常桶和溢出桶）
	if dirtyalloc == nil {
		buckets = newarray(t.bucket, int(nbuckets))
	} else {
		buckets = dirtyalloc
		size := t.bucket.size * nbuckets
		if t.bucket.ptrdata != 0 {
			memclrHasPointers(buckets, size)
		} else {
			memclrNoHeapPointers(buckets, size)
		}
	}
	//根据指针运算定位溢出桶位置，可以看到并未将预申请的溢出桶计入noverflow
	if base != nbuckets {
		nextOverflow = (*bmap)(add(buckets, base*uintptr(t.bucketsize)))//找到属于溢出桶的那部分内存
		last := (*bmap)(add(buckets, (nbuckets-1)*uintptr(t.bucketsize)))//找到最后一个溢出桶
		last.setoverflow(t, (*bmap)(buckets))//设置最后一个溢出桶的溢出指针（即bmap的overflow字段）为第一个桶，这时只是为了占个位
	}
	return buckets, nextOverflow
}
```

### 三、map的查找

针对var a = map[int]bool={1:true}分析，我们进行map查找有两种：

- b:=a[1]。这种情况下key 1 存在就返回相应的value,不存在就返回value类型的零值，即false，对应源码函数为mapaccess1;
- b,ok:=a[1]。这种情况key 1 存在b就是key对应的value，ok为true,否则b就是value类型的零值，ok为false，对应源码函数为mapaccess2;

两种种查找过模式的核心逻辑一样：

- 1、计算key的hash值；
- 2、通过B的大小和hash值来确定key在哪个桶(假设此时B=2，则桶个数b=4,所以取hash值的后4位，如果后四位是0101，0101用十进制表示为5，所以在5号桶）；
- 3、如果处于扩容后的迁移期间，定位key位于的旧桶，若旧桶没被迁移，则到该旧桶查找value;
- 4、通过2、3步定位key所在桶后，计算tophash值，即hash值的高八位；
- 5、遍历桶中元素，根据tophash值和key来找value；
- 6、如果第五步没找到，则切换到溢出桶，如此重复5,6步，找到就结束遍历，否则一直循环，直至遍历完所有溢出桶；

```go
func mapaccess1(t *maptype, h *hmap, key unsafe.Pointer) unsafe.Pointer {
	//省略代码...
	if h == nil || h.count == 0 {//这里可以看出查找未初始化的map也不会报错，直接返回value类型零值
		if t.hashMightPanic() {
			t.hasher(key, 0) 
		}
		return unsafe.Pointer(&zeroVal[0])
	}
	if h.flags&hashWriting != 0 {//如果map正在写，不允许读
		fatal("concurrent map read and map write")
	}
	hash := t.hasher(key, uintptr(h.hash0))// 计算key的hash值
	m := bucketMask(h.B)//计算掩码，即2^B - 1
	//hash&m等价于取模运算（公式：X % 2^ n = X & (2^ n – 1)，只适用于2的次方），用于获取桶的偏移量
	b := (*bmap)(add(h.buckets, (hash&m)*uintptr(t.bucketsize)))//通过
	if c := h.oldbuckets; c != nil {
		if !h.sameSizeGrow() {
			// There used to be half as many buckets; mask down one more power of two.
			m >>= 1
		}
		oldb := (*bmap)(add(c, (hash&m)*uintptr(t.bucketsize)))//定位旧桶
		if !evacuated(oldb) {//旧桶没迁移就到该旧桶查找value
			b = oldb
		}
	}
	top := tophash(hash)//计算tophash，取hash高八位
bucketloop:
	for ; b != nil; b = b.overflow(t) {
		for i := uintptr(0); i < bucketCnt; i++ {
			if b.tophash[i] != top {//通过tophash加速定位key的位置
				if b.tophash[i] == emptyRest {//如果遇到emptyRest标志位，表示不管是正常桶，还是溢出桶，后面都没有元素了，直接跳出循环即可
					break bucketloop
				}
				continue
			}
			k := add(unsafe.Pointer(b), dataOffset+i*uintptr(t.keysize))//tophash相等，就通过指针运算取真实的key值
			if t.indirectkey() {
				k = *((*unsafe.Pointer)(k))
			}
			if t.key.equal(key, k) {//tophash相等只能说明key hash值的高八位一样，还需要对比此key值与要找的key是否相等
				e := add(unsafe.Pointer(b), dataOffset+bucketCnt*uintptr(t.keysize)+i*uintptr(t.elemsize))
				if t.indirectelem() {
					e = *((*unsafe.Pointer)(e))
				}
				return e
			}
		}
	}
	return unsafe.Pointer(&zeroVal[0])
}
```

取hash的掩码：

```go
func bucketShift(b uint8) uintptr {//计算当前桶个数，可以看出桶个数（不包括溢出桶）在64为系统下最多是2^63个，32位系统下最多是2^31个
	// Masking the shift amount allows overflow checks to be elided.
	return uintptr(1) << (b & (goarch.PtrSize*8 - 1))
}
// bucketMask returns 1<<b - 1, optimized for code generation.
func bucketMask(b uint8) uintptr {
	return bucketShift(b) - 1
}
```

### 四、map的插入

插入逻辑步骤如下：

- 1、计算key的hash值；
- 2、通过B的大小和hash值来确定key在哪个桶(假设此时B=2，则桶个数b=4,所以取hash值的后4位，如果后四位是0101，0101用十进制表示为5，所以在5号桶）；
- 3、如果处于扩容后的迁移期间，就先把key所映射的旧桶及其溢出桶的内容迁移到新的桶中;
- 4、遍历新桶，根据tophash值和key来定位key是否存在；
- 5、存在就直接结束，并返回value的地址，用于更新value；
- 6、不存在就找一个空位，用于插入key和value；
- 7、再判定是否需要扩容，需要的话就先扩容，之后跳到第2步；
- 8、不需要扩容就设置key及其tophash,并返回value地址，用户设置value的值。

#### 1、插入源码分析

向map插入键值对核心逻辑就是找key是否存在，存在就更新value值，不存在就插入该键值对，下面一起来看看源码吧。

```go
func mapassign(t *maptype, h *hmap, key unsafe.Pointer) unsafe.Pointer {
	if h == nil {//向未初始化的map中插入数据会panic
		panic(plainError("assignment to entry in nil map"))
	}
	//省略代码...
	if h.flags&hashWriting != 0 {//如果map正在写，不允许插入，否则报错
		fatal("concurrent map writes")
	}
	hash := t.hasher(key, uintptr(h.hash0))// 计算key的hash值
	h.flags ^= hashWriting//设置map状态标志位为正在写
	if h.buckets == nil {//如果当前map的桶未初始化，就申请内存，针对在初始还map时未声明容量大小或容量大小为0的情况
		h.buckets = newobject(t.bucket) // newarray(t.bucket, 1)
	}
again:
	bucket := hash & bucketMask(h.B)//没啥好说的，在查找章节说过了，计算key所在桶的内存偏移量
	if h.growing() {//如果map正在扩容
		growWork(t, h, bucket)//先把key所映射的旧桶内容迁移到新的桶中，详情待后续map 扩容章节讲解
	}
	b := (*bmap)(add(h.buckets, bucket*uintptr(t.bucketsize)))//根据偏移量得到桶内容
	top := tophash(hash)//计算tophash

	var inserti *uint8 
	var insertk unsafe.Pointer
	var elem unsafe.Pointer//key对应value的指针，会赋给该变量
bucketloop:
	for {
		for i := uintptr(0); i < bucketCnt; i++ {
			if b.tophash[i] != top {//tophash值不等，说明key不存在
				if isEmpty(b.tophash[i]) && inserti == nil {//如果当前tophash位置是空的
					inserti = &b.tophash[i] //取当前tophash地址赋给inserti变量
					insertk = add(unsafe.Pointer(b), dataOffset+i*uintptr(t.keysize))//通过指针运算取对应key地址赋给insertK变量
					elem = add(unsafe.Pointer(b), dataOffset+bucketCnt*uintptr(t.keysize)+i*uintptr(t.elemsize))//取对应value地址赋给elem变量
				}
				if b.tophash[i] == emptyRest {//如果遇到emptyRest标志位，表示不管是正常桶，还是溢出桶，后面都没有元素了，直接跳出循环即可
					break bucketloop
				}
				continue
			}
			//tophash值相等，说明key可能存在
			k := add(unsafe.Pointer(b), dataOffset+i*uintptr(t.keysize))
			if t.indirectkey() {
				k = *((*unsafe.Pointer)(k))
			}
			if !t.key.equal(key, k) {//对比此key值与要插入的key是否相等，不相等继续循环
				continue
			}
			// already have a mapping for key. Update it.
			if t.needkeyupdate() {
				typedmemmove(t.key, k, key)
			}
			//key相等的话就将value的地址赋给elem并go to don以退出函数
			elem = add(unsafe.Pointer(b), dataOffset+bucketCnt*uintptr(t.keysize)+i*uintptr(t.elemsize))
			goto done
		}
		//没找到的话就到溢出桶里找
		ovf := b.overflow(t)
		if ovf == nil {//溢出桶存在就找
			break
		}
		b = ovf
	}
  //如果当前map不在进行扩容迁移，判断当前负载是否大于负载因子6.5，或者溢出桶数量是否过多
  //任何一个满足就进行扩容，注意，此时只是扩容，并不迁移，Go map为了避免一次迁移所有数据太耗资源，采用渐进式迁移策略。
	if !h.growing() && (overLoadFactor(h.count+1, h.B) || tooManyOverflowBuckets(h.noverflow, h.B)) {
		hashGrow(t, h)
		goto again //重新跑一遍again 域内的逻辑
	}
  //已有的桶都满了，这个新的key没位置了，就申请一个溢出桶
	if inserti == nil {
		// The current bucket and all the overflow buckets connected to it are full, allocate a new one.
		newb := h.newoverflow(t, b)
		inserti = &newb.tophash[0]
		insertk = add(unsafe.Pointer(newb), dataOffset)
		elem = add(insertk, bucketCnt*uintptr(t.keysize))
	}

	//把新的key,value存储到正当的位置
	if t.indirectkey() {//申请key的内存
		kmem := newobject(t.key)
		*(*unsafe.Pointer)(insertk) = kmem
		insertk = kmem
	}
	if t.indirectelem() {////申请value的内存
		vmem := newobject(t.elem)
		*(*unsafe.Pointer)(elem) = vmem
	}
	typedmemmove(t.key, insertk, key)//存储key
	*inserti = top//存储tophash
	h.count++ //不存在的key就计数+1
//看到这里的同学可能会有疑问，value啥时候存储呢，可以看到最终把value地址elem返回
//在调用完本函数后会将真实的value赋给elem,本函数并不会设置value的值
done:
	if h.flags&hashWriting == 0 {
		fatal("concurrent map writes")
	}
	h.flags &^= hashWriting
	if t.indirectelem() {
		elem = *((*unsafe.Pointer)(elem))
	}
	return elem
}
```

#### 2、溢出桶申请策略

通过阅读mapassign函数源码，我们知道h.newoverflow函数会做溢出桶申请的工作。


通过阅读mapassign函数源码，我们知道h.newoverflow函数会做溢出桶申请的工作。

为什么ovf.overflow(t) == nil 的判定为false就知道该桶是预申请的溢出桶的最后一个呢？
细心的同学应该还记得2.2小节的makeBucketArray函数，关键代码如下：

```go
if base != nbuckets {
		nextOverflow = (*bmap)(add(buckets, base*uintptr(t.bucketsize)))//找到属于溢出桶的那部分内存
		last := (*bmap)(add(buckets, (nbuckets-1)*uintptr(t.bucketsize)))//找到最后一个溢出桶
		last.setoverflow(t, (*bmap)(buckets))//设置最后一个溢出桶的溢出指针（即bmap的overflow字段）为第一个桶，这时只是为了占个位
	}
```

可以看到当初始化map的时候，如果需要预申请溢出桶，就会特地找到最后一个溢出桶，并将其溢出桶指针设置为buckets，即非空。

```go
func (h *hmap) newoverflow(t *maptype, b *bmap) *bmap {
	var ovf *bmap
	if h.extra != nil && h.extra.nextOverflow != nil {//使用预申请的溢出桶，详见2.2节makeBucketArray函数
		// We have preallocated overflow buckets available，See makeBucketArray for more details.
		ovf = h.extra.nextOverflow//预申请的溢出桶
		if ovf.overflow(t) == nil {//判断ovf的溢出桶指针是否为nil，不为nil的话表示则是nextOverflow最后一个桶了
			// We're not at the end of the preallocated overflow buckets. Bump the pointer.
			h.extra.nextOverflow = (*bmap)(add(unsafe.Pointer(ovf), uintptr(t.bucketsize)))//ovf不是最后一个桶的话就将h.extra.nextOverflow后移
		} else {
			// This is the last preallocated overflow bucket， Reset the overflow pointer on this bucket,
			//which was set to a non-nil sentinel value.
			ovf.setoverflow(t, nil)//最后一个桶就把其溢出桶指针重置为nil
			h.extra.nextOverflow = nil//设为nil，表示预申请的溢出桶耗尽，后续就要申请内存了
		}
	} else {
		ovf = (*bmap)(newobject(t.bucket))//申请一个溢出桶
	}
	h.incrnoverflow()//溢出桶计数
	if t.bucket.ptrdata == 0 {
		h.createOverflow()//初始化溢出桶管理
		*h.extra.overflow = append(*h.extra.overflow, ovf)//放到溢出桶数组中
	}
	b.setoverflow(t, ovf)
	return ovf
}

// To keep hmap small, noverflow is a uint16.
// When there are few buckets, noverflow is an exact count.
// When there are many buckets, noverflow is an approximate count.
//溢出桶计数，可以看到当溢出桶个数较小的时候其值是准确的，过大就只是一个近似值
func (h *hmap) incrnoverflow() {
	if h.B < 16 {
		h.noverflow++
		return
	}
	mask := uint32(1)<<(h.B-15) - 1
	// Example: if h.B == 18, then mask == 7, and fastrand & 7 == 0 with probability 1/8.
	if fastrand()&mask == 0 {
		h.noverflow++
	}
}
```

所以可以看出，对于溢出桶的管理分两部分：

- h.extra.nextOverflow是预申请的溢出桶，其与正常桶是在同一个数组。
- h.extra.overflow是当预申请的溢出桶没有的时候才会被初始化，是独立申请的。

### 五、map的删除

删除与插入差不多，只不过找到后要对相应空，找不到就直接返回，这里简单说下。

```go
func mapdelete(t *maptype, h *hmap, key unsafe.Pointer) {
  //省略代码...
	if h == nil || h.count == 0 {//向未初始化的map中插入数据会panic
		if t.hashMightPanic() {
			t.hasher(key, 0) // see issue 23734
		}
		return
	}
	if h.flags&hashWriting != 0 {//如果map正在写，不允许删除，否则panic
		fatal("concurrent map writes")
	}
	hash := t.hasher(key, uintptr(h.hash0))// 计算key的hash值
	h.flags ^= hashWriting//设置map状态标志位为正在写

	bucket := hash & bucketMask(h.B)// 计算key所在桶的内存偏移量
	if h.growing() {//如果map正在扩容
		growWork(t, h, bucket)//先把key所映射的旧桶内容迁移到新的桶中，详情待后续map 扩容章节讲解
	}
	b := (*bmap)(add(h.buckets, bucket*uintptr(t.bucketsize)))
	bOrig := b
	top := tophash(hash)//计算tophash值，取hash高8位
search:
	for ; b != nil; b = b.overflow(t) {//循环遍历正常桶和溢出桶
		for i := uintptr(0); i < bucketCnt; i++ {
			if b.tophash[i] != top {
				if b.tophash[i] == emptyRest {//如果遇到emptyRest标志位还没找到，直接跳出循环即可
					break search
				}
				continue //tophash值不相等就继续循环
			}
			k := add(unsafe.Pointer(b), dataOffset+i*uintptr(t.keysize))
			k2 := k
			if t.indirectkey() {
				k2 = *((*unsafe.Pointer)(k2))
			}
			if !t.key.equal(key, k2) {//此key不等于要删除的key，就继续找
				continue
			}
			//找到了，清除key
			if t.indirectkey() {
				*(*unsafe.Pointer)(k) = nil
			} else if t.key.ptrdata != 0 {
				memclrHasPointers(k, t.key.size)
			}
			//清除value
			e := add(unsafe.Pointer(b), dataOffset+bucketCnt*uintptr(t.keysize)+i*uintptr(t.elemsize))
			if t.indirectelem() {
				*(*unsafe.Pointer)(e) = nil
			} else if t.elem.ptrdata != 0 {
				memclrHasPointers(e, t.elem.size)
			} else {
				memclrNoHeapPointers(e, t.elem.size)
			}
			b.tophash[i] = emptyOne//对应tophash的值设置空标志位
			// If the bucket now ends in a bunch of emptyOne states,
			// change those to emptyRest states.
			// It would be nice to make this a separate function, but
			// for loops are not currently inlineable.
			if i == bucketCnt-1 {
				if b.overflow(t) != nil && b.overflow(t).tophash[0] != emptyRest {//如果当前桶的溢出桶非空桶，表示后面还有键值对
					goto notLast
				}
			} else {
				if b.tophash[i+1] != emptyRest {
					goto notLast
				}
			}
			for {//设置tophash标志位为emptyRest,表示此index之后(包括溢出桶)不存在键值对了，减少查找时的无效遍历
				b.tophash[i] = emptyRest
				//省略代码...
			}
		notLast:
			h.count--
			// Reset the hash seed to make it more difficult for attackers to
			// repeatedly trigger hash collisions. See issue 25237.
			if h.count == 0 {
				h.hash0 = fastrand()//重置hash种子
			}
			break search
		}
	}

	if h.flags&hashWriting == 0 {
		fatal("concurrent map writes")
	}
	h.flags &^= hashWriting
}

```

### 六、map的扩容与迁移

#### 1、扩容条件

扩容有两个条件：
- 当前负载因子大于6.5；
- 有过多的溢出桶

##### 当前负载因子大于6.5

```go
func overLoadFactor(count int, B uint8) bool {
	return count > bucketCnt && uintptr(count) > loadFactorNum*(bucketShift(B)/loadFactorDen)
}
```

逻辑简单，就是当前map键值对个数count除以桶个数2^B > 6.5，当前负载过小说明空间利用率低，负载过大说明冲突严重，存取效率低。

##### 有过多的溢出桶

```go
func tooManyOverflowBuckets(noverflow uint16, B uint8) bool {
	if B > 15 {
		B = 15
	}
	// The compiler doesn't see here that B < 16; mask B to generate shorter shift code.
	return noverflow >= uint16(1)<<(B&15)
}
```

当B<16时，溢出桶个数 大于正常桶个数就属于有过多溢出桶；
当B>16时，溢出桶个数 大于2^15就属于有过多溢出桶；

#### 2、扩容

扩容发生在插入时，如果负载因子大于6.5则进行增量扩容，否则是等量扩容，因为等量扩容时桶个数不变，所以key在新桶的索引也不变
等量扩容也叫伪缩容，它只是把减少溢出桶的数量，并不会减少正常桶数量
扩容逻辑简单，重新申请一块内存，旧的桶暂时放到h.oldbuckets,h.extra.oldoverflow字段上。

```go
func hashGrow(t *maptype, h *hmap) {
	// If we've hit the load factor, get bigger.
	// Otherwise, there are too many overflow buckets,
	// so keep the same number of buckets and "grow" laterally.
	bigger := uint8(1)
	if !overLoadFactor(h.count+1, h.B) {//如果不满足负载因子大于6.5，但满足有过多溢出桶，说明键值对存储不够紧凑，浪费了大量空间
		bigger = 0
		h.flags |= sameSizeGrow//等量扩容
	}
	oldbuckets := h.buckets
	newbuckets, nextOverflow := makeBucketArray(t, h.B+bigger, nil)//重新申请内存，不管是增量扩容还是等量扩容

	flags := h.flags &^ (iterator | oldIterator)
	if h.flags&iterator != 0 {
		flags |= oldIterator
	}
	// commit the grow (atomic wrt gc)
	h.B += bigger
	h.flags = flags
	h.oldbuckets = oldbuckets//将旧的桶转移
	h.buckets = newbuckets//设置新的桶
	h.nevacuate = 0
	h.noverflow = 0//

	if h.extra != nil && h.extra.overflow != nil {
		// Promote current overflow buckets to the old generation.
		if h.extra.oldoverflow != nil {
			throw("oldoverflow is not nil")
		}
		h.extra.oldoverflow = h.extra.overflow //将旧的溢出桶转移
		h.extra.overflow = nil
	}
	if nextOverflow != nil {
		if h.extra == nil {
			h.extra = new(mapextra)
		}
		h.extra.nextOverflow = nextOverflow//设置新的预申请的溢出桶
	}
}
```

#### 3、迁移

迁移发生在插入和删除时，并且每次最多迁移2个bucket,一个是插入删除key所映射的旧桶，另一个是按照迁移进度排到的旧桶，这样就能保证一定能迁移完，如果只迁移插入删除key所映射的旧桶，虽说严格遵循了copy on write,但可能会导致很久很久也迁不完。

> 迁移插入删除key所映射的旧桶，不表示旧桶中一定包含该key。

```go
func growWork(t *maptype, h *hmap, bucket uintptr) {
	// make sure we evacuate the oldbucket corresponding to the bucket we're about to use
	evacuate(t, h, bucket&h.oldbucketmask())//优先迁移插入删除key所映射的旧桶
	// evacuate one more oldbucket to make progress on growing
	if h.growing() {
		evacuate(t, h, h.nevacuate)//按正常的迁移进度迁
	}
}
func evacuate(t *maptype, h *hmap, oldbucket uintptr) {
	b := (*bmap)(add(h.oldbuckets, oldbucket*uintptr(t.bucketsize)))
	newbit := h.noldbuckets()//旧桶的个数
	if !evacuated(b) {//判定下当前桶是否迁移过了，已经迁移的不操作了，否则进行迁移操作
		//迁移旧桶及其溢出桶代码 ...
	}

	if oldbucket == h.nevacuate {
		advanceEvacuationMark(h, t, newbit)//更新迁移进度
	}
}
func advanceEvacuationMark(h *hmap, t *maptype, newbit uintptr) {
	h.nevacuate++
	stop := h.nevacuate + 1024
	if stop > newbit {
		stop = newbit
	}
	for h.nevacuate != stop && bucketEvacuated(t, h, h.nevacuate) {//如果下一个旧桶也迁移完了，就令h.nevacuate++
		h.nevacuate++
	}
	if h.nevacuate == newbit { // 表示迁移完了，将h.oldbuckets与h.extra.oldoverflow置空
		h.oldbuckets = nil
		if h.extra != nil {
			h.extra.oldoverflow = nil
		}
		h.flags &^= sameSizeGrow
	}
}
```