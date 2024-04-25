import { h } from 'preact'

import type { Body, Meta } from '@uppy/utils/lib/UppyFile'
import type { PartialTree, PartialTreeFile, PartialTreeFolderNode, PartialTreeFolderRoot, UnknownSearchProviderPlugin, UnknownSearchProviderPluginState } from '@uppy/core/lib/Uppy.ts'
import type { CompanionFile } from '@uppy/utils/lib/CompanionFile'
import SearchFilterInput from '../SearchFilterInput.tsx'
import Browser from '../Browser.tsx'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore We don't want TS to generate types for the package.json
import packageJson from '../../package.json'
import getTagFile from '../utils/getTagFile.ts'
import getNOfSelectedFiles from '../utils/getNOfSelectedFiles.ts'
import PartialTreeUtils from '../utils/PartialTreeUtils'
import shouldHandleScroll from '../utils/shouldHandleScroll.ts'
import handleError from '../utils/handleError.ts'
import validateRestrictions from '../utils/validateRestrictions.ts'

const defaultState : UnknownSearchProviderPluginState = {
  loading: false,
  searchString: '',
  partialTree: [
    {
      type: 'root',
      id: null,
      cached: false,
      nextPagePath: null
    }
  ],
  currentFolderId: null,
  isInputMode: true,
}

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>

interface Opts<M extends Meta, B extends Body> {
  provider: UnknownSearchProviderPlugin<M, B>['provider']
  viewType: 'list' | 'grid'
  showTitles: boolean
  showFilter: boolean
}
type PassedOpts<M extends Meta, B extends Body> = Optional<Opts<M, B>, 'viewType' | 'showTitles' | 'showFilter'>
type DefaultOpts<M extends Meta, B extends Body> = Omit<Opts<M, B>, 'provider'>
type RenderOpts<M extends Meta, B extends Body> = Omit<PassedOpts<M, B>, 'provider'>

type Res = {
  items: CompanionFile[]
  nextPageQuery: string | null
  searchedFor: string
}

/**
 * SearchProviderView, used for Unsplash and future image search providers.
 * Extends generic View, shared with regular providers like Google Drive and Instagram.
 */
export default class SearchProviderView<M extends Meta, B extends Body> {
  static VERSION = packageJson.version

  plugin: UnknownSearchProviderPlugin<M, B>
  provider: UnknownSearchProviderPlugin<M, B>['provider']
  opts: Opts<M, B>

  isHandlingScroll: boolean = false
  lastCheckbox: string | null = null

  constructor(
    plugin: UnknownSearchProviderPlugin<M, B>,
    opts: PassedOpts<M, B>,
  ) {
    this.plugin = plugin
    this.provider = opts.provider
    const defaultOptions : DefaultOpts<M, B> = {
      viewType: 'grid',
      showTitles: true,
      showFilter: true,
    }
    this.opts = { ...defaultOptions, ...opts }

    this.setSearchString = this.setSearchString.bind(this)
    this.search = this.search.bind(this)
    this.resetPluginState = this.resetPluginState.bind(this)
    this.handleScroll = this.handleScroll.bind(this)
    this.donePicking = this.donePicking.bind(this)
    this.cancelPicking = this.cancelPicking.bind(this)
    this.toggleCheckbox = this.toggleCheckbox.bind(this)

    this.render = this.render.bind(this)

    // Set default state for the plugin
    this.resetPluginState()

    // @ts-expect-error this should be typed in @uppy/dashboard.
    this.plugin.uppy.on('dashboard:close-panel', this.resetPluginState)

    this.plugin.uppy.registerRequestClient(this.provider.provider, this.provider)
  }

  // eslint-disable-next-line class-methods-use-this
  tearDown(): void {
    // Nothing.
  }

  setLoading(loading: boolean | string): void {
    this.plugin.setPluginState({ loading })
  }

  resetPluginState(): void {
    this.plugin.setPluginState(defaultState)
  }

  cancelPicking(): void {
    const dashboard = this.plugin.uppy.getPlugin('Dashboard')
    if (dashboard) {
      // @ts-expect-error impossible to type this correctly without adding dashboard
      // as a dependency to this package.
      dashboard.hideAllPanels()
    }
  }

  async search(): Promise<void> {
    const { searchString } = this.plugin.getPluginState()
    if (searchString === '') return

    this.setLoading(true)
    try {
      const response = await this.provider.search<Res>(searchString)

      const newPartialTree : PartialTree = [
        {
          type: 'root',
          id: null,
          cached: false,
          nextPagePath: response.nextPageQuery
        },
        ...response.items.map((item) => ({
          type: 'file',
          id: item.requestPath,
          status: 'unchecked',
          parentId: null,
          data: item
        }) as PartialTreeFile)
      ]
      this.plugin.setPluginState({
        partialTree: newPartialTree,
        isInputMode: false
      })
    } catch (error) {
      handleError(this.plugin.uppy)(error)
    }
    this.setLoading(false)
  }

  async handleScroll(event: Event): Promise<void> {
    const { partialTree, searchString } = this.plugin.getPluginState()
    const root = partialTree.find((i) => i.type === 'root') as PartialTreeFolderRoot

    if (shouldHandleScroll(event) && !this.isHandlingScroll && root.nextPagePath) {
      this.isHandlingScroll = true
      try {
        const response = await this.provider.search<Res>(searchString, root.nextPagePath)

        const newRoot : PartialTreeFolderRoot = {
          ...root,
          nextPagePath: response.nextPageQuery
        }
        const oldItems = partialTree.filter((i) => i.type !== 'root')

        const newPartialTree : PartialTree = [
          newRoot,
          ...oldItems,
          ...response.items.map((item) => ({
            type: 'file',
            id: item.requestPath,
            status: 'unchecked',
            parentId: null,
            data: item
          }) as PartialTreeFile)
        ]
        this.plugin.setPluginState({ partialTree: newPartialTree })
      } catch (error) {
        handleError(this.plugin.uppy)(error)
      }
      this.isHandlingScroll = false
    }
  }

  donePicking(): void {
    const { partialTree } = this.plugin.getPluginState()
    this.plugin.uppy.log('Adding remote search provider files')
    const files = partialTree.filter((i) => i.type !== 'root' && i.status === 'checked') as PartialTreeFile[]
    const tagFiles = files.map((file) =>
      getTagFile<M>(file.data, this.plugin.id, this.provider, this.plugin.opts.companionUrl)
    )
    this.plugin.uppy.addFiles(tagFiles)

    this.resetPluginState()
  }

  toggleCheckbox(e: Event, ourItem: PartialTreeFolderNode | PartialTreeFile, isShiftKeyPressed: boolean) {
    e.stopPropagation()
    e.preventDefault()
    // Prevent shift-clicking from highlighting file names
    // (https://stackoverflow.com/a/1527797/3192470)
    document.getSelection()?.removeAllRanges()

    const { partialTree, currentFolderId } = this.plugin.getPluginState()

    const displayedPartialTree = partialTree.filter((item) => item.type !== 'root' && item.parentId === currentFolderId) as (PartialTreeFolderNode | PartialTreeFile)[]
    const newPartialTree = PartialTreeUtils.afterToggleCheckbox(partialTree, displayedPartialTree, ourItem, validateRestrictions(this.plugin), isShiftKeyPressed, this.lastCheckbox)

    this.plugin.setPluginState({ partialTree: newPartialTree })
    this.lastCheckbox = ourItem.id!
  }

  setSearchString = (searchString: string) => {
    this.plugin.setPluginState({ searchString })
    if (searchString === '') {
      this.plugin.setPluginState({ partialTree: [] })
    }
  }

  render(
    state: unknown,
    viewOptions: RenderOpts<M, B>
  ): JSX.Element {
    const { isInputMode, searchString, loading, partialTree, currentFolderId } =
      this.plugin.getPluginState()
    const { i18n } = this.plugin.uppy
    const opts : Opts<M, B> = { ...this.opts, ...viewOptions }

    if (isInputMode) {
      return (
        <SearchFilterInput
          searchString={searchString}
          setSearchString={this.setSearchString}
          submitSearchString={this.search}

          inputLabel={i18n('enterTextToSearch')}
          buttonLabel={i18n('searchImages')}
          wrapperClassName="uppy-SearchProvider"
          inputClassName="uppy-c-textInput uppy-SearchProvider-input"
          buttonCSSClassName="uppy-SearchProvider-searchButton"
          showButton
        />
      )
    }

    return (
      <Browser
        toggleCheckbox={this.toggleCheckbox}
        displayedPartialTree={partialTree.filter((item) => item.type !== 'root' && item.parentId === currentFolderId) as (PartialTreeFolderNode | PartialTreeFile)[]}
        nOfSelectedFiles={getNOfSelectedFiles(partialTree)}
        handleScroll={this.handleScroll}
        done={this.donePicking}
        cancel={this.cancelPicking}
        getFolder={() => {}}
        showSearchFilter={opts.showFilter}
        searchString={searchString}
        setSearchString={this.setSearchString}
        submitSearchString={this.search}
        searchInputLabel={i18n('search')}
        clearSearchLabel={i18n('resetSearch')}
        noResultsLabel={i18n('noSearchResults')}
        viewType={opts.viewType}
        showTitles={opts.showTitles}
        isLoading={loading}
        i18n={i18n}
        validateRestrictions={validateRestrictions(this.plugin)}
      />
    )
  }
}
